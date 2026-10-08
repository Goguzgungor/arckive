import { describe, expect, it } from 'vitest';
import { Hub, type Sink } from '../lib/hub.js';
import { HEARTBEAT, RETRY, frame, parseLastEventId } from '../lib/sse.js';
import type { BlockMsg, StatsMsg } from '../lib/types.js';

const block = (n: number, moves = 1): BlockMsg => ({
  n, t: 1000 + n, moves: Array.from({ length: moves }, (_, li) => ({ tx: `0x${n}`, li, from: '0xa', to: '0xb', value: '1', lane: null })),
});
const STATS: StatsMsg = { count: 1, usdc: '1', perSec: 1, lanes: {}, largest: [], headT: null, now: 5 };

const dec = new TextDecoder();
// got: the decoded chunks; raw: the bytes the hub handed over, to check they are shared
function sink(accept = true): Sink & { got: string[]; raw: Uint8Array[]; closed: boolean } {
  return {
    got: [], raw: [], closed: false,
    send(c) { if (!accept) return false; this.raw.push(c); this.got.push(dec.decode(c)); return true; },
    close() { this.closed = true; },
  };
}
const helloIn = (chunk: string): { blocks: BlockMsg[] } => JSON.parse(chunk.split('data: ')[1]!);

describe('SSE framing', () => {
  it('writes id, event and one data line', () => {
    expect(frame('block', { a: 'x\ny' }, 7)).toBe('id: 7\nevent: block\ndata: {"a":"x\\ny"}\n\n');
    expect(frame('stats', { b: 1 })).toBe('event: stats\ndata: {"b":1}\n\n');
    expect(HEARTBEAT).toBe(': hb\n\n');
    expect(RETRY).toBe('retry: 3000\n\n');
  });
  it('reads Last-Event-ID from the header, else the query', () => {
    expect(parseLastEventId('42', null)).toBe(42);
    expect(parseLastEventId(null, '43')).toBe(43);
    expect(parseLastEventId('x', null)).toBeNull();
    expect(parseLastEventId(null, null)).toBeNull();
  });
  it('reads ?last= when the header is there but empty', () => {
    expect(parseLastEventId('', '43')).toBe(43);
    expect(parseLastEventId('  ', '43')).toBe(43);
    expect(parseLastEventId('', null)).toBeNull();
  });
});

describe('Hub', () => {
  it('greets a new viewer with the latest movements, at most 40', () => {
    const hub = new Hub(10);
    hub.seed([block(1, 30), block(2, 30)], 2);
    const s = sink();
    expect(hub.subscribe(s, null)).toEqual(expect.any(Function));
    expect(s.got[0]).toBe(RETRY);
    const hello = JSON.parse(s.got[1]!.split('data: ')[1]!);
    expect(hello.blocks.flatMap((b: BlockMsg) => b.moves)).toHaveLength(40);
    expect(s.got[1]).toMatch(/^id: 2\nevent: hello\n/);
  });

  it('resumes a viewer from Last-Event-ID while the buffer still holds what came after', () => {
    const hub = new Hub(10);
    hub.seed([block(10)], 10);
    hub.publishBlocks([11, 12, 13].map((n) => block(n)));
    hub.publishStats(STATS);
    const s = sink();
    hub.subscribe(s, 11);
    expect(s.got.slice(1)).toEqual([frame('block', block(12), 12), frame('block', block(13), 13), frame('stats', STATS)]);
  });

  it('sends a fresh hello when the buffer moved past the viewer', () => {
    const hub = new Hub(10, 2);
    hub.seed([block(10)], 10);
    hub.publishBlocks([11, 12, 13, 14].map((n) => block(n)));
    const s = sink();
    hub.subscribe(s, 10);
    expect(s.got[1]).toMatch(/event: hello/);
  });

  it('fans blocks, stats and heartbeats out, and drops a viewer that stops reading', () => {
    const hub = new Hub(10);
    const a = sink();
    const slow = sink();
    hub.subscribe(a, null);
    hub.subscribe(slow, null);
    slow.send = () => false;
    hub.publishBlocks([block(1)]);
    expect(a.got.at(-1)).toBe(frame('block', block(1), 1));
    expect(slow.closed).toBe(true);
    expect(hub.size).toBe(1);
    hub.heartbeat();
    expect(a.got.at(-1)).toBe(HEARTBEAT);
  });

  it('refuses viewers beyond MAX_STREAMS and frees a slot on unsubscribe', () => {
    const hub = new Hub(1);
    const off = hub.subscribe(sink(), null)!;
    expect(hub.full()).toBe(true);
    expect(hub.subscribe(sink(), null)).toBeNull();
    off();
    expect(hub.subscribe(sink(), null)).not.toBeNull();
  });

  it('survives a sink whose send throws during a publish', () => {
    const hub = new Hub(10);
    const bad = sink();
    const good = sink();
    hub.subscribe(bad, null);
    hub.subscribe(good, null);
    bad.send = () => { throw new Error('stream closed'); };
    expect(() => hub.publishBlocks([block(1)])).not.toThrow();
    expect(bad.closed).toBe(true);
    expect(good.got.at(-1)).toBe(frame('block', block(1), 1));
    expect(hub.size).toBe(1);
    expect(hub.newest()).toBe(1);
  });

  it('does not count a sink whose first send throws on subscribe', () => {
    const hub = new Hub(1);
    const bad = sink();
    bad.send = () => { throw new Error('stream closed'); };
    expect(() => hub.subscribe(bad, null)).not.toThrow();
    expect(hub.size).toBe(0);
    expect(bad.closed).toBe(true);
    expect(hub.subscribe(sink(), null)).not.toBeNull();
  });

  it('refuses a stream whose first send fails, so the route can answer 503', () => {
    const hub = new Hub(10);
    const thrower = sink();
    thrower.send = () => { throw new Error('stream closed'); };
    expect(hub.subscribe(sink(false), null)).toBeNull();
    expect(hub.subscribe(thrower, null)).toBeNull();
    expect(hub.size).toBe(0);
  });

  it('removes a sink whose close throws', () => {
    const hub = new Hub(10);
    const bad = sink(false);
    bad.close = () => { throw new Error('already closed'); };
    hub.subscribe(bad, null);
    expect(hub.size).toBe(0);
    const bad2 = sink();
    hub.subscribe(bad2, null);
    bad2.send = () => false;
    bad2.close = () => { throw new Error('already closed'); };
    expect(() => hub.publishBlocks([block(1)])).not.toThrow();
    expect(hub.size).toBe(0);
  });
  it('sends a cycle of blocks as one chunk per viewer, encoded once', () => {
    const hub = new Hub(10);
    const a = sink();
    const b = sink();
    hub.subscribe(a, null);
    hub.subscribe(b, null);
    const blocks = Array.from({ length: 150 }, (_, i) => block(100 + i));
    hub.publishBlocks(blocks);
    expect(a.got).toHaveLength(3); // retry, hello, the cycle
    expect(a.got[2]).toBe(blocks.map((x) => frame('block', x, x.n)).join(''));
    expect(b.raw[2]).toBe(a.raw[2]);
    expect(hub.newest()).toBe(249);
    expect(hub.hello().blocks.flatMap((x) => x.moves)).toHaveLength(40);
  });

  it('greets every open viewer again on reseed', () => {
    const hub = new Hub(10);
    const s = sink();
    hub.subscribe(s, null);
    expect(helloIn(s.got[1]!).blocks).toEqual([]);
    hub.reseed([block(7), block(8)], 8);
    expect(s.got[2]).toMatch(/^id: 8\nevent: hello\n/);
    expect(helloIn(s.got[2]!).blocks.map((b) => b.n)).toEqual([7, 8]);
    expect(hub.newest()).toBe(8);
  });

  it('greets a viewer that is ahead of the buffer instead of resuming it with nothing', () => {
    const hub = new Hub(10);
    hub.seed([block(10), block(11)], 11);
    const ahead = sink();
    hub.subscribe(ahead, 500); // it saw block 500 from a server whose buffer this one never had
    expect(ahead.got[1]).toMatch(/^id: 11\nevent: hello\n/);
    const empty = new Hub(10);
    const early = sink();
    empty.subscribe(early, 3); // the buffer is empty while the server boots
    expect(early.got[1]).toMatch(/event: hello/);
  });

  it('serialises the hello once until the next publish', () => {
    const hub = new Hub(10);
    hub.seed([block(1)], 1);
    const a = sink();
    const b = sink();
    hub.subscribe(a, null);
    hub.subscribe(b, null);
    expect(b.raw[1]).toBe(a.raw[1]);
    hub.publishStats(STATS);
    const c = sink();
    hub.subscribe(c, null);
    expect(c.raw[1]).not.toBe(a.raw[1]);
    expect(c.got[1]).toContain('"stats":{"count":1');
  });
});
