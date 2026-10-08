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
    hub.publishBlock(block(2));
    hub.publishBlock(block(3));
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
    await open.body!.cancel();
    expect(streamResponse(hub, new Request('http://x/api/stream')).status).toBe(200);
  });
});
