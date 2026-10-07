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

export async function bootstrapInsights(pool: pg.Pool, schema: string, start: bigint): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of buildInsightsTables(schema)) await client.query(s);
    await client.query(
      `INSERT INTO ${q(schema)}._insights_cursor (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
      [start.toString()],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
    const hexOf = (col: string) => `'0x' || encode(${q(col)}, 'hex')`;
    const extra = c ? `, ${hexOf(c[0])} AS t_from, ${hexOf(c[1])} AS t_to, ${q(c[2])}::text AS t_value` : '';
    const r = await pool.query(
      `SELECT block_number, ${hexOf('tx_hash')} AS tx_hash, log_index${extra} FROM ${q(schema)}.${q(t.tableName)}
       WHERE block_number BETWEEN $1 AND $2`,
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
  await client.query(
    `INSERT INTO ${q(schema)}._sentences (sentence, model, probabilities)
     SELECT * FROM unnest($1::text[], $2::text[], $3::jsonb[]) ON CONFLICT (sentence, model) DO NOTHING`,
    [all.map((x) => x.sentence), all.map((x) => x.model), all.map((x) => x.probabilities)],
  );
  const r = await client.query(
    `SELECT s.id, s.sentence, s.model FROM ${q(schema)}._sentences s
     JOIN unnest($1::text[], $2::text[]) AS u(sentence, model) USING (sentence, model)`,
    [all.map((x) => x.sentence), all.map((x) => x.model)],
  );
  return new Map(r.rows.map((x) => [key(x.sentence, x.model), Number(x.id)]));
}

// Rows and cursor in one transaction, like commitBatch: a round is either all
// written or not at all. Returns the lanes of the rows actually inserted.
export async function commitInsights(
  pool: pg.Pool, schema: string, partitions: Partitions, rows: InsightRow[], newCursor: bigint,
): Promise<string[]> {
  const planned = partitions.plan(rows.length ? ['_insights'] : [], rows.map((r) => r.blockNumber));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of planned) await client.query(p.sql);
    let inserted: string[] = [];
    if (rows.length) {
      const ids = await sentenceIds(client, schema, rows);
      // facts cannot travel through unnest as an array of arrays (unnest
      // flattens them): each row's facts go as one comma-joined string, split
      // here. Fact names are identifiers and never contain commas.
      const res = await client.query(
        `INSERT INTO ${q(schema)}._insights
           (block_number, log_index, lane, lane_p, ruled, protocol, facts, sentence_id)
         SELECT b, l, lane, p, ruled, protocol,
                CASE WHEN f = '' THEN '{}'::text[] ELSE string_to_array(f, ',') END, sid
         FROM unnest($1::bigint[], $2::integer[], $3::text[], $4::real[], $5::boolean[], $6::text[], $7::text[], $8::integer[])
              AS u(b, l, lane, p, ruled, protocol, f, sid)
         ON CONFLICT (block_number, log_index) DO NOTHING
         RETURNING lane`,
        [
          rows.map((r) => r.blockNumber.toString()),
          rows.map((r) => r.logIndex),
          rows.map((r) => r.lane),
          rows.map((r) => r.laneP),
          rows.map((r) => r.ruled),
          rows.map((r) => r.protocol || null),
          rows.map((r) => r.facts.join(',')),
          rows.map((r) => ids.get(`${r.model ?? ''}\u0000${r.sentence}`)!),
        ],
      );
      inserted = res.rows.map((x) => x.lane as string);
    }
    await client.query(
      `UPDATE ${q(schema)}._insights_cursor SET last_block = $1, updated_at = now() WHERE id = 1`,
      [newCursor.toString()],
    );
    await client.query('COMMIT');
    partitions.remember(planned);
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
