import { readyRuntime } from '../../../../../lib/runtime.js';
import { decodeParam, parseTxHash } from '../../../../../lib/search.js';
import { laneOrder, loadLane, loadTx } from '../../../../../lib/tx.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The transaction page polls this while Laya is reading the transaction.
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }): Promise<Response> {
  const hash = parseTxHash(decodeParam((await ctx.params).hash));
  if (!hash) return Response.json({ error: 'not a transaction hash' }, { status: 404 });
  try {
    const rt = readyRuntime();
    const tx = await loadTx(rt.pool, rt.t, hash);
    if (!tx) return Response.json({ error: 'no indexed event in this transaction' }, { status: 404 });
    const lane = await loadLane(rt.pool, rt.t, rt.insights, tx.block, laneOrder(tx));
    return Response.json({ lane }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'the archive is not answering' }, { status: 503 });
  }
}
