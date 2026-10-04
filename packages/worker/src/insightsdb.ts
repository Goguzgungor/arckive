import type pg from 'pg';
import { buildInsightsTables } from '@arckive/core';

const q = (id: string) => `"${id}"`;

export interface InsightRow {
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  tableName: string;
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
    const extra = c ? `, ${q(c[0])} AS t_from, ${q(c[1])} AS t_to, ${q(c[2])}::text AS t_value` : '';
    const r = await pool.query(
      `SELECT block_number, tx_hash, log_index${extra} FROM ${q(schema)}.${q(t.tableName)}
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

// Rows and cursor in one transaction, like commitBatch: a round is either all
// written or not at all. Returns the lanes of the rows actually inserted.
export async function commitInsights(
  pool: pg.Pool, schema: string, rows: InsightRow[], newCursor: bigint,
): Promise<string[]> {
  const client = await pool.connect();
  const inserted: string[] = [];
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO ${q(schema)}._insights
           (block_number, tx_hash, log_index, table_name, lane, lane_p, ruled, protocol,
            facts, probabilities, sentence, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (block_number, tx_hash, log_index) DO NOTHING`,
        [
          r.blockNumber.toString(), r.txHash, r.logIndex, r.tableName, r.lane, r.laneP, r.ruled, r.protocol,
          JSON.stringify(r.facts), r.probabilities ? JSON.stringify(r.probabilities) : null, r.sentence, r.model,
        ],
      );
      if (res.rowCount) inserted.push(r.lane);
    }
    await client.query(
      `UPDATE ${q(schema)}._insights_cursor SET last_block = $1, updated_at = now() WHERE id = 1`,
      [newCursor.toString()],
    );
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
