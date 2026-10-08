import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import { BUSY, CURSOR, SELF } from './fixture/rows.ts';
import { tables } from '../lib/db.js';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';
import type { Logger } from '../lib/log.js';
import { ROLLUP_LOCK, Rollup } from '../lib/rollup.js';

const T = tables({ schema: 'idx_arc_explorer', usdcTable: 'usdc_transfer', poolPrefix: 'poolmanager_' });

// The same sums straight from the transfers: what address_daily must equal.
const DIRECT = `
SELECT address_id, day::text AS day, sum(in_value)::text AS in_value, sum(out_value)::text AS out_value,
       sum(in_count)::int AS in_count, sum(out_count)::int AS out_count
FROM (
  SELECT t.to_id AS address_id, (b.block_time AT TIME ZONE 'UTC')::date AS day, t.value AS in_value, 0::numeric AS out_value, 1 AS in_count, 0 AS out_count
  FROM ${T.usdc} t JOIN ${T.blocks} b ON b.block_number = t.block_number
  UNION ALL
  SELECT t.from_id, (b.block_time AT TIME ZONE 'UTC')::date, 0, t.value, 0, 1
  FROM ${T.usdc} t JOIN ${T.blocks} b ON b.block_number = t.block_number
) m GROUP BY 1, 2 ORDER BY 1, 2`;
const ROLLED = `SELECT address_id, day::text AS day, in_value::text AS in_value, out_value::text AS out_value, in_count, out_count
FROM explorer.address_daily ORDER BY 1, 2`;

async function drain(r: Rollup): Promise<number> {
  let steps = 0;
  for (;;) {
    steps++;
    if ((await r.step()) !== 'more') return steps;
  }
}

describe('rollup', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb();
    await ensureExplorerSchema(db.explorer);
  });
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    await db.admin.query('TRUNCATE explorer.address_daily, explorer.rollup_cursor');
  });

  it('folds every transfer into per-address per-day totals', async () => {
    const r = new Rollup(db.explorer, T);
    // 50,000-block ranges: the fixture's first rows, then the busy blocks
    expect(await drain(r)).toBe(2);
    expect((await db.explorer.query(ROLLED)).rows).toEqual((await db.explorer.query(DIRECT)).rows);
    expect(await r.rolledTo()).toBe(24861160);
  });

  it('gets the same totals folding in small uneven ranges', async () => {
    const r = new Rollup(db.explorer, T, { maxSpan: 37n });
    expect(await drain(r)).toBeGreaterThan(5);
    expect((await db.explorer.query(ROLLED)).rows).toEqual((await db.explorer.query(DIRECT)).rows);
  });

  it('folds nothing twice when a range dies before its commit', async () => {
    let n = 0;
    const crashing = new Rollup(db.explorer, T, {
      maxSpan: 200n,
      beforeCommit: async () => { if (++n === 2) throw new Error('killed'); },
    });
    expect(await crashing.step()).toBe('more');
    await expect(crashing.step()).rejects.toThrow('killed');
    await drain(new Rollup(db.explorer, T, { maxSpan: 200n }));
    expect((await db.explorer.query(ROLLED)).rows).toEqual((await db.explorer.query(DIRECT)).rows);
  });

  it('counts a self-transfer on both sides and splits days in UTC', async () => {
    await drain(new Rollup(db.explorer, T));
    const self = await db.explorer.query(
      `SELECT in_count, out_count FROM explorer.address_daily d JOIN ${T.addresses} a ON a.id = d.address_id WHERE a.address = $1`,
      [Buffer.from(SELF.slice(2), 'hex')],
    );
    expect(self.rows).toEqual([{ in_count: 1, out_count: 1 }]);
    const busy = await db.explorer.query(
      `SELECT day::text AS day FROM explorer.address_daily d JOIN ${T.addresses} a ON a.id = d.address_id WHERE a.address = $1 ORDER BY 1`,
      [Buffer.from(BUSY.slice(2), 'hex')],
    );
    expect(busy.rows.map((x) => x.day)).toEqual(['2026-10-07', '2026-10-08']);
  });

  it('skips a round while another replica holds the lock', async () => {
    const holder = new pg.Client({ connectionString: db.adminUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [ROLLUP_LOCK]);
    try {
      expect(await new Rollup(db.explorer, T).step()).toBe('locked');
    } finally {
      await holder.end();
    }
  });

  it('halves its span when a range outlives the statement timeout, and grows back', async () => {
    const r = new Rollup(db.explorer, T, {
      maxSpan: 4000n,
      beforeCommit: async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
    });
    await expect(r.step()).rejects.toThrow(/statement timeout/);
    expect(r.span).toBe(2000n);
    await expect(r.step()).rejects.toThrow(/statement timeout/);
    expect(r.span).toBe(1000n);
  });

  it('is idle once caught up with the worker', async () => {
    const r = new Rollup(db.explorer, T);
    await drain(r);
    expect(await r.step()).toBe('idle');
  });

  it('folds nothing, and says once a minute how to reset, when it is ahead of the worker (its schema was recreated)', async () => {
    await db.admin.query('INSERT INTO explorer.rollup_cursor (id, block_number) VALUES (1, $1)', [CURSOR + 1000]);
    let now = 0;
    const r = new Rollup(db.explorer, T, { now: () => now, idleMs: 10 });
    expect(await r.step()).toBe('ahead');
    expect((await db.explorer.query('SELECT count(*)::int AS n FROM explorer.address_daily')).rows[0].n).toBe(0);
    expect(await r.rolledTo()).toBe(CURSOR + 1000);
    const errors: string[] = [];
    const logger = { error: (_o: unknown, m: string) => errors.push(m), warn: () => undefined } as unknown as Logger;
    const steps = vi.spyOn(r, 'step');
    const stop = r.start(logger);
    try {
      await vi.waitFor(() => expect(steps.mock.calls.length).toBeGreaterThanOrEqual(5), { timeout: 15_000 });
      expect(errors).toHaveLength(1);
      now += 60_000;
      await vi.waitFor(() => expect(errors).toHaveLength(2), { timeout: 15_000 });
    } finally {
      stop();
    }
    expect(errors[0]).toMatch(/TRUNCATE explorer\.address_daily, explorer\.rollup_cursor/);
  });
});
