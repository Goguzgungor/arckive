import { describe, expect, it } from 'vitest';
import { Hub, type Sink } from '../lib/hub.js';
import { HEARTBEAT, RETRY, frame, parseLastEventId } from '../lib/sse.js';
import type { BlockMsg, StatsMsg } from '../lib/types.js';

const block = (n: number, moves = 1): BlockMsg => ({
  n, t: 1000 + n, moves: Array.from({ length: moves }, (_, li) => ({ tx: `0x${n}`, li, from: '0xa', to: '0xb', value: '1', lane: null })),
});
const STATS: StatsMsg = { count: 1, usdc: '1', perSec: 1, lanes: {}, largest: [], now: 5 };

function sink(accept = true): Sink & { got: string[]; closed: boolean } {
  return { got: [], closed: false, send(c) { if (!accept) return false; this.got.push(c); return true; }, close() { this.closed = true; } };
}

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
    for (const n of [11, 12, 13]) hub.publishBlock(block(n));
    hub.publishStats(STATS);
    const s = sink();
    hub.subscribe(s, 11);
    expect(s.got.slice(1)).toEqual([frame('block', block(12), 12), frame('block', block(13), 13), frame('stats', STATS)]);
  });

  it('sends a fresh hello when the buffer moved past the viewer', () => {
    const hub = new Hub(10, 2);
    hub.seed([block(10)], 10);
    for (const n of [11, 12, 13, 14]) hub.publishBlock(block(n));
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
    hub.publishBlock(block(1));
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
});
