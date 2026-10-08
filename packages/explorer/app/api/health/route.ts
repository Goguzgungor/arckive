import { getRuntime } from '../../../lib/runtime.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Readiness for Kubernetes, and the numbers the real test reads.
export async function GET(): Promise<Response> {
  try {
    const rt = getRuntime();
    if (!rt.ready) return Response.json({ ok: false }, { status: 503 });
    await rt.pool.query('SELECT 1');
    return Response.json({
      ok: true,
      head: rt.head,
      released: rt.tailer.lastReleased,
      rolledTo: rt.rolledTo,
      lanes: rt.insights.on,
      streams: rt.hub.size,
      tailerMs: rt.tailer.cycleStats(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
