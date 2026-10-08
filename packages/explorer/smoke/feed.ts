// Writes one block every 500 ms the way the worker does — _blocks, transfers,
// their lanes, then both cursors in one transaction — so the real tailer has
// a tape to release. Relative imports carry .ts (Node's type stripping).
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { partitionDdl } from '@arckive/core';
import * as R from '../test/fixture/rows.ts';

const S = `"${R.SCHEMA}"`;
const PARTIES = [R.POOLMANAGER, R.ROUTER, R.PAYER, R.PAYEE, R.BUSY, ...R.CPS, R.SWAP_PAYER];
const LANES = ['swap', 'swap', 'payment', 'payment', 'signed_payment', 'bridge'];
const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export function startFeed(admin: pg.Pool, everyMs = 500): () => void {
  let n = R.CURSOR;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const made = new Set<string>();
  const ids = new Map<string, number>();
  const labels = new Map<string, number>();

  const idOf = async (c: pg.PoolClient, a: string): Promise<number> => {
    if (!ids.has(a)) {
      const r = await c.query<{ id: number }>(`SELECT id FROM ${S}._addresses WHERE address = $1`, [bytes(a)]);
      ids.set(a, r.rows[0]!.id);
    }
    return ids.get(a)!;
  };
  const labelOf = async (c: pg.PoolClient, lane: string): Promise<number> => {
    if (!labels.has(lane)) {
      const s = await c.query<{ id: number }>(
        `INSERT INTO ${S}._sentences (sentence, model) VALUES ($1, 'laya') ON CONFLICT (sentence, model) DO UPDATE SET sentence = excluded.sentence RETURNING id`,
        [`smoke ${lane}`],
      );
      const l = await c.query<{ id: number }>(
        `INSERT INTO ${S}._labels (lane, lane_p, ruled, protocol, facts, sentence_id) VALUES ($1, 0.9, false, NULL, '{}', $2)
         ON CONFLICT (lane, lane_p, ruled, protocol, facts, sentence_id) DO UPDATE SET lane = excluded.lane RETURNING id`,
        [lane, s.rows[0]!.id],
      );
      labels.set(lane, l.rows[0]!.id);
    }
    return labels.get(lane)!;
  };

  const tick = async (): Promise<void> => {
    n += 1;
    const part = BigInt(n) / R.PARTITION_BLOCKS;
    for (const table of ['_blocks', 'usdc_transfer', '_insights']) {
      const key = `${table}:${part}`;
      if (!made.has(key)) {
        await admin.query(partitionDdl(R.SCHEMA, table, part, R.PARTITION_BLOCKS));
        made.add(key);
      }
    }
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO ${S}._blocks (block_number, block_hash, block_time) VALUES ($1, $2, now())`, [n, randomBytes(32)]);
      const moves = 1 + Math.floor(Math.random() * 3);
      for (let li = 0; li < moves; li++) {
        const from = pick(PARTIES);
        let to = pick(PARTIES);
        while (to === from) to = pick(PARTIES);
        const value = (BigInt(1 + Math.floor(Math.random() * 200_000)) * 10n ** 16n).toString();
        await c.query(
          `INSERT INTO ${S}.usdc_transfer (block_number, tx_hash, log_index, from_id, to_id, value) VALUES ($1, $2, $3, $4, $5, $6)`,
          [n, randomBytes(32), li, await idOf(c, from), await idOf(c, to), value],
        );
        const lane = pick(LANES);
        await c.query(`INSERT INTO ${S}._insights (block_number, log_index, lane, label_id) VALUES ($1, $2, $3, $4)`, [n, li, lane, await labelOf(c, lane)]);
      }
      await c.query(`UPDATE ${S}._cursor SET last_block = $1`, [n]);
      await c.query(`UPDATE ${S}._insights_cursor SET last_block = $1`, [n]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };

  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (err) {
      console.error('smoke feed:', err instanceof Error ? err.message : err);
    }
    if (!stopped) timer = setTimeout(loop, everyMs);
  };
  void loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
