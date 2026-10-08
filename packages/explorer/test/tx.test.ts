import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { loadInsightsInfo, laneOrder, loadLane, loadTx, type InsightsInfo } from '../lib/tx.js';
import { laneWhy } from '../lib/lanewhy.js';

describe('transactions', () => {
  let db: TestDb;
  let info: InsightsInfo;
  beforeAll(async () => {
    db = await startDb();
    info = await loadInsightsInfo(db.explorer, db.t, true);
  });
  afterAll(async () => { await db?.stop(); });

  it('loads the mainnet swap with its pool', async () => {
    const tx = await loadTx(db.explorer, db.t, R.SWAP_TX);
    expect(tx).toEqual({
      hash: R.SWAP_TX,
      block: 24787775,
      time: Date.UTC(2026, 9, 7, 20, 33, 32) / 1000,
      transfers: [
        { li: 1, from: R.SWAP_PAYER, to: R.SWAP_HOP, value: R.SWAP_PAID },
        { li: 2, from: R.SWAP_HOP, to: R.ROUTER, value: R.SWAP_PAID },
        { li: 4, from: R.ROUTER, to: R.POOLMANAGER, value: R.SWAP_PAID },
      ],
      swaps: [{ li: 3, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: `-${R.SWAP_PAID}`, amount1: R.SWAP_RECEIVED, fee: 2500 }],
      modifies: [],
      donates: [],
      inits: [],
      pools: { [R.SWAP_POOL]: { id: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO } },
    });
  });

  it('loads pool-only transactions', async () => {
    const tx = await loadTx(db.explorer, db.t, R.POOL_TX);
    expect(tx?.transfers).toEqual([]);
    expect(tx?.modifies).toEqual([{ li: 0, pool: R.SWAP_POOL, sender: R.LP, tickLower: -600, tickUpper: 600, liquidityDelta: '1000000000000' }]);
    expect(tx?.donates).toEqual([{ li: 1, pool: R.SWAP_POOL, sender: R.LP, amount0: R.usdc(1), amount1: '0' }]);
    const init = await loadTx(db.explorer, db.t, R.INIT_TX);
    expect(init?.inits).toEqual([{ li: 3, pool: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO }]);
  });

  it('returns null for a hash Arckive has no event for', async () => {
    expect(await loadTx(db.explorer, db.t, `0x${'ab'.repeat(32)}`)).toBeNull();
  });

  it('orders transfers before pool events when picking the lane row', async () => {
    const tx = (await loadTx(db.explorer, db.t, R.SWAP_TX))!;
    expect(laneOrder(tx)).toEqual([1, 2, 4, 3]);
  });

  it('knows where lanes began', () => {
    expect(info).toEqual({ on: true, firstBlock: R.FIRST_LANE_BLOCK, firstTime: Date.UTC(2026, 9, 7, 20, 33, 32) / 1000 });
  });

  it('reads a model lane, a ruled lane, and the states without one', async () => {
    expect(await loadLane(db.explorer, db.t, info, 24787775, [1, 2, 4, 3])).toEqual({
      kind: 'read', lane: 'swap', p: 0.91, ruled: false,
      sentence: 'USDC moved from a wallet to a contract, amount 100 to 1,000 USDC. In the same transaction: tokens were swapped on an exchange.',
      why: 'Tokens were swapped on an exchange or traded on a marketplace.',
    });
    expect(await loadLane(db.explorer, db.t, info, 24787802, [0])).toMatchObject({ kind: 'read', lane: 'issuance', p: null, ruled: true });
    expect(await loadLane(db.explorer, db.t, info, 24787025, [3])).toEqual({ kind: 'before', since: info.firstTime });
    expect(await loadLane(db.explorer, db.t, info, 24787803, [0])).toEqual({ kind: 'none' });
    expect(await loadLane(db.explorer, db.t, info, R.busyBlock(25), [0])).toEqual({ kind: 'pending' });
    expect(await loadLane(db.explorer, db.t, { on: false, firstBlock: null, firstTime: null }, 24787775, [1])).toEqual({ kind: 'off' });
  });

  it('explains ruled and unsure lanes', () => {
    expect(laneWhy('issuance', true)).toMatch(/^Ruled: USDC was minted or burned/);
    expect(laneWhy('uncertain', false)).toMatch(/not sure enough/);
    expect(laneWhy('payment', false)).toBe('A plain direct transfer, with nothing else happening.');
  });
});

describe('transactions before lanes exist', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb({ insights: false }); });
  afterAll(async () => { await db?.stop(); });

  it('loads a transaction and reports lanes off without touching _insights', async () => {
    const info = await loadInsightsInfo(db.explorer, db.t, false);
    expect(info).toEqual({ on: false, firstBlock: null, firstTime: null });
    const tx = await loadTx(db.explorer, db.t, R.PAY_TX);
    expect(tx?.transfers).toEqual([{ li: 0, from: R.PAYER, to: R.PAYEE, value: R.usdc(311, 55) }]);
    expect(await loadLane(db.explorer, db.t, info, tx!.block, [0])).toEqual({ kind: 'off' });
  });
});
