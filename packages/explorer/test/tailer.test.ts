import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { Hub, type Sink } from '../lib/hub.js';
import { log } from '../lib/log.js';
import { nameOf } from '../lib/names.js';
import { Tailer } from '../lib/tailer.js';

const dec = new TextDecoder();
function collector(): Sink & { got: string[] } {
  return { got: [], send(c) { this.got.push(dec.decode(c)); return true; }, close() {} };
}
// every frame of a kind across the chunks (one tailer cycle is one chunk)
const framesIn = (got: string[], event: string) => got.join('').split('\n\n')
  .filter((f) => f.includes(`event: ${event}\n`)).map((f) => JSON.parse(f.split('data: ')[1]!));
const blocksIn = (got: string[]) => framesIn(got, 'block');
const hellosIn = (got: string[]) => framesIn(got, 'hello');

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
    // the whole cycle went out as one chunk
    expect(viewer.got.filter((c) => c.includes('event: block'))).toHaveLength(1);
    expect(first.moves[2]).toMatchObject({ from: R.ROUTER, to: R.POOLMANAGER, toName: 'Uniswap v4 Pools', lane: 'swap', value: '476.9325', tx: R.SWAP_TX, li: 4 });
    expect(first.moves[2].fromName).toBe(nameOf(R.ROUTER));
  });

  it('skips far ahead with a fresh hello to open streams, not a replay of the gap', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 0, lanes: () => true, log });
    const viewer = collector();
    hub.subscribe(viewer, null);
    tailer.lastReleased = 24787774;
    await tailer.cycle();
    expect(tailer.lastReleased).toBe(R.CURSOR);
    expect(blocksIn(viewer.got)).toEqual([]);
    expect(viewer.got.at(-1)).toMatch(new RegExp(`^id: ${R.CURSOR}\nevent: hello\n`));
    expect(hellosIn(viewer.got).at(-1).blocks.at(-1).n).toBe(R.CURSOR);
  });

  it('starts over with a fresh hello when the worker cursor goes back (its schema was recreated)', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 0, lanes: () => true, log });
    await tailer.init();
    const count = tailer.window.stats(0).count;
    expect(count).toBeGreaterThan(0);
    const viewer = collector();
    hub.subscribe(viewer, null);
    tailer.lastReleased = R.CURSOR + 10_000;
    await tailer.cycle();
    expect(tailer.lastReleased).toBe(R.CURSOR);
    expect(hellosIn(viewer.got)).toHaveLength(2); // on subscribe, and on the reload
    expect(hellosIn(viewer.got)[1].blocks.at(-1).n).toBe(R.CURSOR);
    // the rolling minute was rebuilt, not folded a second time
    expect(tailer.window.stats(0).count).toBe(count);
  });

  it('warns when a read returns as many rows as its limit (the rest of the range is not on the tape)', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const tailer = new Tailer({ pool: db.explorer, t: db.t, hub: new Hub(10), holdMs: 0, lanes: () => true, log });
      (tailer as unknown as { maxRows: number }).maxRows = 3;
      await tailer.init();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ rows: 3 }), expect.stringMatching(/row limit/));
    } finally {
      warn.mockRestore();
    }
  });

  it('publishes stats on its timer and stops cleanly', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 0, lanes: () => true, log });
    const viewer = collector();
    hub.subscribe(viewer, null);
    const stop = tailer.start();
    try {
      // stats go out once a second; a loaded machine may take longer
      await vi.waitFor(() => {
        expect(viewer.got.some((c) => c.includes('event: stats'))).toBe(true);
        expect(tailer.cycleStats().last).toEqual(expect.any(Number));
      }, { timeout: 15_000, interval: 50 });
    } finally {
      stop();
    }
  });
});

describe('tailer (lanes not on yet)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb({ insights: false }); });
  afterAll(async () => { await db?.stop(); });

  it('releases up to the worker cursor at once, without lanes', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 8000, lanes: () => false, log });
    // a viewer who connected while the server was booting
    const early = collector();
    hub.subscribe(early, null);
    await tailer.init();
    expect(tailer.lastReleased).toBe(R.CURSOR);
    const hellos = hellosIn(early.got);
    expect(hellos).toHaveLength(2);
    expect(hellos[0].blocks).toEqual([]);
    expect(hellos[1].blocks.at(-1).n).toBe(R.CURSOR);
    const moves = hub.hello().blocks.flatMap((b) => b.moves);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.lane === null)).toBe(true);
  });
});
