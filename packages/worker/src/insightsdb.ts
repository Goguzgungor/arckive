import type pg from 'pg';
import { buildInsightsTables } from '@arckive/core';
import type { Partitions } from './db.js';

const q = (id: string) => `"${id}"`;

export interface InsightRow {
  blockNumber: bigint;
  logIndex: number;
  lane: string;
  laneP: number | null;
  ruled: boolean;
  protocol: string;
  facts: string[];
  probabilities: Record<string, number> | null;
  sentence: string;
  model: string | null;
}

// An event table the insight loop reads, and for ERC-20-shaped Transfers the
// columns holding from, to and value.
export interface EventSource {
  tableName: string;
  transferColumns: readonly [string, string, string] | null;
}

export interface EventRow {
  tableName: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  transfer: { from: string; to: string; value: bigint } | null;
}

// start: the initial insights cursor, or null to create the tables only —
// a start relative to the head is written by the loop's first round
// (insights.ts prepareRound), when the head is known.
export async function bootstrapInsights(pool: pg.Pool, schema: string, start: bigint | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of buildInsightsTables(schema)) await client.query(s);
    if (start !== null) {
      await client.query(
        `INSERT INTO ${q(schema)}._insights_cursor (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
        [start.toString()],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Written once: an existing cursor is the loop's progress and is never moved.
export async function initInsightsCursor(pool: pg.Pool, schema: string, lastBlock: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO ${q(schema)}._insights_cursor (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [lastBlock.toString()],
  );
}

export async function getInsightsCursor(pool: pg.Pool, schema: string): Promise<bigint | null> {
  const r = await pool.query(`SELECT last_block FROM ${q(schema)}._insights_cursor WHERE id = 1`);
  return r.rowCount ? BigInt(r.rows[0].last_block) : null;
}

// The last block of [from, to] that keeps the round at maxRows rows or fewer.
// A single block holding more is taken whole: a round never ends mid-block,
// because the cursor only says which blocks are done.
export async function capRange(
  pool: pg.Pool, schema: string, tables: readonly EventSource[], from: bigint, to: bigint, maxRows: number,
): Promise<bigint> {
  const union = tables
    .map((t) => `SELECT block_number FROM ${q(schema)}.${q(t.tableName)} WHERE block_number BETWEEN $1 AND $2`)
    .join(' UNION ALL ');
  const r = await pool.query(
    `SELECT block_number FROM (${union}) r ORDER BY block_number OFFSET $3 LIMIT 1`,
    [from.toString(), to.toString(), maxRows],
  );
  if (!r.rowCount) return to;
  const cut = BigInt(r.rows[0].block_number);
  return cut > from ? cut - 1n : from;
}

export async function readEventRows(
  pool: pg.Pool, schema: string, tables: readonly EventSource[], from: bigint, to: bigint,
): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for (const t of tables) {
    const c = t.transferColumns;
    const hexOf = (expr: string) => `'0x' || encode(${expr}, 'hex')`;
    // transfer parties are stored as ids; readers resolve them through _addresses
    const joins = c
      ? ` LEFT JOIN ${q(schema)}._addresses af ON af.id = e.${q(c[0])} LEFT JOIN ${q(schema)}._addresses at ON at.id = e.${q(c[1])}`
      : '';
    const extra = c ? `, ${hexOf('af.address')} AS t_from, ${hexOf('at.address')} AS t_to, e.${q(c[2])}::text AS t_value` : '';
    const r = await pool.query(
      `SELECT e.block_number, ${hexOf('e.tx_hash')} AS tx_hash, e.log_index${extra}
       FROM ${q(schema)}.${q(t.tableName)} e${joins}
       WHERE e.block_number BETWEEN $1 AND $2`,
      [from.toString(), to.toString()],
    );
    for (const x of r.rows) {
      rows.push({
        tableName: t.tableName,
        blockNumber: BigInt(x.block_number),
        txHash: x.tx_hash,
        logIndex: x.log_index,
        transfer: c ? { from: x.t_from, to: x.t_to, value: BigInt(x.t_value) } : null,
      });
    }
  }
  return rows.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}

// A dictionary id that the select after the insert did not return. Without
// this, undefined would travel on as NULL and surface as an opaque NOT NULL
// violation far from the cause; the message names the key's parts instead.
export class DictionaryMissError extends Error {
  constructor(what: string, parts: Record<string, unknown>) {
    super(`${what} id missing after insert: ${JSON.stringify(parts)}`);
    this.name = 'DictionaryMissError';
  }
}

export function needId(ids: ReadonlyMap<string, number>, k: string, what: string, parts: Record<string, unknown>): number {
  const id = ids.get(k);
  if (id === undefined) throw new DictionaryMissError(what, parts);
  return id;
}

// Sentence ids for a round: one insert of the new (sentence, model) pairs and
// one select of all of them. Sentences are few — Radar caches answers per
// exact sentence for the same reason — so this stays two small statements.
async function sentenceIds(client: pg.PoolClient, schema: string, rows: InsightRow[]): Promise<Map<string, number>> {
  const key = (sentence: string, model: string) => `${model}\u0000${sentence}`;
  const unique = new Map<string, { sentence: string; model: string; probabilities: string | null }>();
  for (const r of rows) {
    const model = r.model ?? '';
    unique.set(key(r.sentence, model), {
      sentence: r.sentence, model, probabilities: r.probabilities ? JSON.stringify(r.probabilities) : null,
    });
  }
  const all = [...unique.values()];
  const sentences = all.map((x) => x.sentence);
  const models = all.map((x) => x.model);
  const probs = all.map((x) => x.probabilities);
  // Only pairs that do not exist yet: an identity value is consumed before
  // ON CONFLICT is checked, so re-inserting known sentences would burn ids.
  await client.query(
    `INSERT INTO ${q(schema)}._sentences (sentence, model, probabilities)
     SELECT u.sentence, u.model, u.p FROM unnest($1::text[], $2::text[], $3::jsonb[]) AS u(sentence, model, p)
     WHERE NOT EXISTS (SELECT 1 FROM ${q(schema)}._sentences x WHERE x.sentence = u.sentence AND x.model = u.model)
     ON CONFLICT (sentence, model) DO NOTHING`,
    [sentences, models, probs],
  );
  // a ruled row (NULL probabilities) may already hold this sentence under model ''; an answered one must not be lost
  await client.query(
    `UPDATE ${q(schema)}._sentences s SET probabilities = u.p
     FROM unnest($1::text[], $2::text[], $3::jsonb[]) AS u(sentence, model, p)
     WHERE s.sentence = u.sentence AND s.model = u.model AND s.probabilities IS NULL AND u.p IS NOT NULL`,
    [sentences, models, probs],
  );
  const r = await client.query(
    `SELECT s.id, s.sentence, s.model FROM ${q(schema)}._sentences s
     JOIN unnest($1::text[], $2::text[]) AS u(sentence, model) USING (sentence, model)`,
    [all.map((x) => x.sentence), all.map((x) => x.model)],
  );
  return new Map(r.rows.map((x) => [key(x.sentence, x.model), Number(x.id)]));
}

// Label ids for a round, like sentences: one insert of the new label tuples
// and one select of all of them. lane_p and protocol may be NULL; the unique
// constraint treats NULLs as equal and the select matches them with IS NOT
// DISTINCT FROM, so a NULL-carrying label still resolves to one id. facts
// cannot travel through unnest as an array of arrays (unnest flattens them):
// each label's facts go as one comma-joined string, split in SQL. Fact names
// are identifiers and never contain commas.
async function labelIds(
  client: pg.PoolClient, schema: string, rows: InsightRow[], sentenceIdOf: Map<string, number>,
): Promise<Map<string, number>> {
  // lane_p is a real column: pg prints float4 with the shortest decimal that
  // round-trips (0.9), which parses to a different double than the float32 we
  // sent, so keys fround both the sent value and the value read back.
  const key = (lane: string, p: number | null, ruled: boolean, protocol: string | null, f: string, sid: number) =>
    JSON.stringify([lane, p, ruled, protocol, f, sid]);
  const unique = new Map<string, { lane: string; p: number | null; ruled: boolean; protocol: string | null; f: string; sid: number }>();
  for (const r of rows) {
    const sid = needId(sentenceIdOf, `${r.model ?? ''}\u0000${r.sentence}`, 'sentence',
      { model: r.model ?? '', sentence: r.sentence });
    const p = r.laneP === null ? null : Math.fround(r.laneP);
    const protocol = r.protocol || null;
    const f = r.facts.join(',');
    unique.set(key(r.lane, p, r.ruled, protocol, f, sid), { lane: r.lane, p, ruled: r.ruled, protocol, f, sid });
  }
  const all = [...unique.values()];
  const args = [
    all.map((x) => x.lane), all.map((x) => x.p), all.map((x) => x.ruled),
    all.map((x) => x.protocol), all.map((x) => x.f), all.map((x) => x.sid),
  ];
  const input = 'unnest($1::text[], $2::real[], $3::boolean[], $4::text[], $5::text[], $6::integer[]) AS u(lane, p, ruled, protocol, f, sid)';
  const facts = (f: string) => `(CASE WHEN ${f} = '' THEN '{}'::text[] ELSE string_to_array(${f}, ',') END)`;
  const l = `${q(schema)}._labels`;
  // Only tuples that do not exist yet: an identity value is consumed before
  // ON CONFLICT is checked, so re-inserting known labels would burn ids.
  await client.query(
    `INSERT INTO ${l} (lane, lane_p, ruled, protocol, facts, sentence_id)
     SELECT u.lane, u.p, u.ruled, u.protocol, ${facts('u.f')}, u.sid FROM ${input}
     WHERE NOT EXISTS (SELECT 1 FROM ${l} x WHERE x.lane = u.lane AND x.lane_p IS NOT DISTINCT FROM u.p
       AND x.ruled = u.ruled AND x.protocol IS NOT DISTINCT FROM u.protocol
       AND x.facts = ${facts('u.f')} AND x.sentence_id = u.sid)
     ON CONFLICT (lane, lane_p, ruled, protocol, facts, sentence_id) DO NOTHING`,
    args,
  );
  const r = await client.query(
    `SELECT l.id, l.lane, l.lane_p, l.ruled, l.protocol, array_to_string(l.facts, ',') AS f, l.sentence_id
     FROM ${l} l JOIN ${input}
       ON l.lane = u.lane AND l.lane_p IS NOT DISTINCT FROM u.p AND l.ruled = u.ruled
      AND l.protocol IS NOT DISTINCT FROM u.protocol AND l.facts = ${facts('u.f')} AND l.sentence_id = u.sid`,
    args,
  );
  const ids = new Map(r.rows.map((x) => [key(x.lane, x.lane_p === null ? null : Math.fround(x.lane_p), x.ruled, x.protocol, x.f, x.sentence_id), Number(x.id)]));
  return new Map(rows.map((row) => {
    const sid = needId(sentenceIdOf, `${row.model ?? ''}\u0000${row.sentence}`, 'sentence',
      { model: row.model ?? '', sentence: row.sentence });
    const k = key(row.lane, row.laneP === null ? null : Math.fround(row.laneP), row.ruled, row.protocol || null, row.facts.join(','), sid);
    const id = needId(ids, k, 'label', {
      lane: row.lane, lane_p: row.laneP, ruled: row.ruled, protocol: row.protocol || null,
      facts: row.facts.join(','), sentence_id: sid,
    });
    return [`${row.blockNumber}:${row.logIndex}`, id] as const;
  }));
}

// Rows and cursor in one transaction, like commitBatch: a round is either all
// written or not at all. Returns the lanes of the rows actually inserted.
export async function commitInsights(
  pool: pg.Pool, schema: string, partitions: Partitions, rows: InsightRow[], newCursor: bigint,
): Promise<string[]> {
  const written = rows.length ? ['_insights'] : [];
  const blockNumbers = rows.map((r) => r.blockNumber);
  const planned = partitions.plan(written, blockNumbers);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of planned) await client.query(p.sql);
    let inserted: string[] = [];
    if (rows.length) {
      const sids = await sentenceIds(client, schema, rows);
      const labels = await labelIds(client, schema, rows, sids);
      const res = await client.query(
        `INSERT INTO ${q(schema)}._insights (block_number, log_index, lane, label_id)
         SELECT * FROM unnest($1::bigint[], $2::integer[], $3::text[], $4::integer[])
         ON CONFLICT (block_number, log_index) DO NOTHING
         RETURNING lane`,
        [
          rows.map((r) => r.blockNumber.toString()),
          rows.map((r) => r.logIndex),
          rows.map((r) => r.lane),
          rows.map((r) => needId(labels, `${r.blockNumber}:${r.logIndex}`, 'label',
            { block_number: r.blockNumber.toString(), log_index: r.logIndex })),
        ],
      );
      inserted = res.rows.map((x) => x.lane as string);
    }
    await client.query(
      `UPDATE ${q(schema)}._insights_cursor SET last_block = $1, updated_at = now() WHERE id = 1`,
      [newCursor.toString()],
    );
    await client.query('COMMIT');
    partitions.committed(written, blockNumbers, planned);
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
