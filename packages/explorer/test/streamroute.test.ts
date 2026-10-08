import { describe, expect, it } from 'vitest';
import { Hub } from '../lib/hub.js';
import { streamResponse } from '../lib/streamroute.js';
import type { BlockMsg } from '../lib/types.js';

const block = (n: number): BlockMsg => ({ n, t: n, moves: [{ tx: `0x${n}`, li: 0, from: '0xa', to: '0xb', value: '1', lane: null }] });

async function firstChunks(res: Response, n: number): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (let i = 0; i < n; i++) {
    const r = await reader.read();
    if (r.done) break;
    text += dec.decode(r.value);
  }
  return { text, reader };
}

describe('GET /api/stream', () => {
  it('opens an event stream that starts with hello', async () => {
    const hub = new Hub(5);
    hub.seed([block(1)], 1);
    const res = streamResponse(hub, new Request('http://x/api/stream'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const { text, reader } = await firstChunks(res, 2);
    expect(text).toContain('retry: 3000');
    expect(text).toContain('event: hello');
    await reader.cancel();
    expect(hub.size).toBe(0);
  });

  it('resumes from Last-Event-ID or ?last=', async () => {
    const hub = new Hub(5);
    hub.seed([block(1)], 1);
    hub.publishBlocks([block(2), block(3)]);
    for (const req of [
      new Request('http://x/api/stream', { headers: { 'Last-Event-ID': '2' } }),
      new Request('http://x/api/stream?last=2'),
    ]) {
      const { text, reader } = await firstChunks(streamResponse(hub, req), 2);
      expect(text).toContain('id: 3\nevent: block');
      expect(text).not.toContain('event: hello');
      await reader.cancel();
    }
  });

  it('answers 503 beyond MAX_STREAMS', async () => {
    const hub = new Hub(1);
    const open = streamResponse(hub, new Request('http://x/api/stream'));
    const busy = streamResponse(hub, new Request('http://x/api/stream'));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(await busy.text()).toBe('Stream unavailable; the page retries on its own.');
    await open.body!.cancel();
    expect(streamResponse(hub, new Request('http://x/api/stream')).status).toBe(200);
  });
  it('keeps a viewer through a cycle of 150 blocks and delivers every one of them', async () => {
    const hub = new Hub(5);
    hub.seed([block(1)], 1);
    const res = streamResponse(hub, new Request('http://x/api/stream'));
    const reader = res.body!.getReader();
    // a stall or a backfill round releases many blocks in one tailer cycle
    hub.publishBlocks(Array.from({ length: 150 }, (_, i) => block(2 + i)));
    hub.publishBlocks([block(152)]);
    expect(hub.size).toBe(1);
    const dec = new TextDecoder();
    let text = '';
    while (!text.includes('id: 152\n')) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value);
    }
    const ids = [...text.matchAll(/^id: (\d+)\nevent: block$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(Array.from({ length: 151 }, (_, i) => 2 + i));
    expect(hub.size).toBe(1);
    await reader.cancel();
  });
});
