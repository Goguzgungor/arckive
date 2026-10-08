import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      await bootRuntime(rt, () => { throw new Error('should not exit'); });
      expect(rt.ready).toBe(true);
      expect(rt.insights).toEqual({ on: true, firstBlock: R.FIRST_LANE_BLOCK, firstTime: expect.any(Number) });
      expect(rt.head).toEqual({ block: R.CURSOR, time: Date.UTC(2026, 9, 8, 0, 0, 38) / 1000 });
      expect(rt.dbBytes).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 1500));
      expect(rt.hub.newest()).not.toBeNull();
      expect(await rt.rollup.rolledTo()).toBe(R.CURSOR);
    } finally {
      rt.stop();
      await rt.pool.end();
    }
  });

  it('exits when the schema is not the one it reads', async () => {
    const rt = createRuntime(loadConfig({ DATABASE_URL: db.explorerUrl, USDC_TABLE: 'usdc_transfers' }), reader);
    let code: number | null = null;
    try {
      await bootRuntime(rt, (c) => { code = c; });
      expect(code).toBe(1);
      expect(rt.ready).toBe(false);
    } finally {
      rt.stop();
      await rt.pool.end();
    }
  });
});
