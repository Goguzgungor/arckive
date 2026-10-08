import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { loadConfig } from '../lib/config.js';
import { bootRuntime, createRuntime } from '../lib/runtime.js';

const reader = { read: async () => ({ symbol: null, decimals: null }) };

describe('runtime', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db?.stop(); });

  it('boots: checks the schema, creates its tables, starts the tailer and the rollup', async () => {
    const rt = createRuntime(loadConfig({ DATABASE_URL: db.explorerUrl }), reader);
    try {
      // pages wait at most 3 s for a connection; the jobs have their own clients
      expect(rt.pool).not.toBe(rt.jobs);
      expect(rt.pool.options).toMatchObject({ max: 10, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
      expect(rt.jobs.options).toMatchObject({ max: 4, statement_timeout: 5000 });
      await bootRuntime(rt, () => { throw new Error('should not exit'); });
      expect(rt.ready).toBe(true);
      expect(rt.insights).toEqual({ on: true, firstBlock: R.FIRST_LANE_BLOCK, firstTime: expect.any(Number) });
      expect(rt.head).toEqual({ block: R.CURSOR, time: Date.UTC(2026, 9, 8, 0, 0, 38) / 1000 });
      expect(rt.dbBytes).toBeGreaterThan(0);
      // the tailer seeds the hub and the rollup folds the fixture on their own timers
      await vi.waitFor(async () => {
        expect(rt.hub.newest()).not.toBeNull();
        expect(await rt.rollup.rolledTo()).toBe(R.CURSOR);
      }, { timeout: 30_000, interval: 100 });
    } finally {
      await rt.stop();
    }
    expect(rt.pool.ended && rt.jobs.ended).toBe(true);
  });

  it('exits when the schema is not the one it reads', async () => {
    const rt = createRuntime(loadConfig({ DATABASE_URL: db.explorerUrl, USDC_TABLE: 'usdc_transfers' }), reader);
    let code: number | null = null;
    try {
      await bootRuntime(rt, (c) => { code = c; });
      expect(code).toBe(1);
      expect(rt.ready).toBe(false);
    } finally {
      await rt.stop();
    }
  });
});
