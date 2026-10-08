import type { Hub, Sink } from './hub.js';
import { parseLastEventId } from './sse.js';

const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform: the server's gzip must not buffer the stream
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

// GET /api/stream. A viewer whose queue fills (it stopped reading) is
// dropped rather than buffered without end; its client notices the silence
// and reconnects with ?last=.
export function streamResponse(hub: Hub, req: Request): Response {
  const last = parseLastEventId(req.headers.get('last-event-id'), new URL(req.url).searchParams.get('last'));
  const enc = new TextEncoder();
  const sub: { off: (() => void) | null } = { off: null };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const sink: Sink = {
          send(chunk) {
            if ((controller.desiredSize ?? 1) <= 0) return false;
            controller.enqueue(enc.encode(chunk));
            return true;
          },
          close() {
            try {
              controller.close();
            } catch {
              // already closed by the viewer
            }
          },
        };
        sub.off = hub.subscribe(sink, last);
      },
      cancel() {
        sub.off?.();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 64 }),
  );
  if (!sub.off) {
    return new Response('Too many viewers right now; the page retries on its own.', {
      status: 503,
      headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
    });
  }
  req.signal.addEventListener('abort', () => sub.off?.(), { once: true });
  return new Response(stream, { headers: HEADERS });
}
