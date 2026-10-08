import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { Hub, type Sink } from '../lib/hub.js';
import { log } from '../lib/log.js';
import { nameOf } from '../lib/names.js';
import { Tailer } from '../lib/tailer.js';

function collector(): Sink & { got: string[] } {
  return { got: [], send(c) { this.got.push(c); return true; }, close() {} };
}
const blocksIn = (got: string[]) => got.filter((c) => c.includes('event: block')).map((c) => JSON.parse(c.split('data: ')[1]!));

describe('tailer (lanes on)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db?.stop(); });

  it('holds fresh rows for their lane, then releases them when the hold runs out', async () => {
    await db.admin.query(`UPDATE ${db.t.blocks} SET _ingested_at = now()`);
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 8000, lanes: () => true, log });
    await tailer.init();
    // everything was ingested just now: only blocks with lanes go out
    expect(tailer.lastReleased).toBe(R.INSIGHTS_CURSOR);
    expect(hub.newest()).toBe(R.INSIGHTS_CURSOR);
    const viewer = collector();
    hub.subscribe(viewer, null);

    await tailer.cycle();
    expect(blocksIn(viewer.got)).toEqual([]);

    await db.admin.query(`UPDATE ${db.t.blocks} SET _ingested_at = now() - interval '1 minute' WHERE block_number <= $1`, [R.busyBlock(25)]);
    await tailer.cycle();
    const sent = blocksIn(viewer.got);
    expect(sent.map((b) => b.n)).toEqual([20, 21, 22, 23, 24, 25].map(R.busyBlock));
    expect(sent[0].moves[0]).toMatchObject({ lane: null, to: R.BUSY, value: '21.25' });
    expect(tailer.lastReleased).toBe(R.busyBlock(25));
  });

  it('names known contracts and attaches lanes', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 0, lanes: () => true, log });
    tailer.lastReleased = 24787774;
    await tailer.cycle();
    const swap = hub.hello().blocks.find((b) => b.n === 24787775);
    // the cycle skipped far ahead (more than 600 blocks behind): only the last ~150 blocks are sent
    expect(swap).toBeUndefined();
    tailer.lastReleased = 24787774;
    (tailer as unknown as { maxGap: number }).maxGap = Number.MAX_SAFE_INTEGER;
    const viewer = collector();
    hub.subscribe(viewer, null);
    await tailer.cycle();
    const first = blocksIn(viewer.got)[0];
    expect(first.n).toBe(24787775);
    expect(first.moves[2]).toMatchObject({ from: R.ROUTER, to: R.POOLMANAGER, toName: 'Uniswap v4 Pools', lane: 'swap', value: '476.9325', tx: R.SWAP_TX, li: 4 });
    expect(first.moves[2].fromName).toBe(nameOf(R.ROUTER));
  });

  it('publishes stats on its timer and stops cleanly', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 0, lanes: () => true, log });
    const viewer = collector();
    hub.subscribe(viewer, null);
    const stop = tailer.start();
    await new Promise((r) => setTimeout(r, 1500));
    stop();
    expect(viewer.got.some((c) => c.includes('event: stats'))).toBe(true);
    expect(tailer.cycleStats().last).toEqual(expect.any(Number));
  });
});

describe('tailer (lanes not on yet)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb({ insights: false }); });
  afterAll(async () => { await db?.stop(); });

  it('releases up to the worker cursor at once, without lanes', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 8000, lanes: () => false, log });
    await tailer.init();
    expect(tailer.lastReleased).toBe(R.CURSOR);
    const moves = hub.hello().blocks.flatMap((b) => b.moves);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.lane === null)).toBe(true);
  });
});
