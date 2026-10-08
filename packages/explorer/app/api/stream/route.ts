import { getRuntime } from '../../../lib/runtime.js';
import { streamResponse } from '../../../lib/streamroute.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request): Response {
  return streamResponse(getRuntime().hub, req);
}
