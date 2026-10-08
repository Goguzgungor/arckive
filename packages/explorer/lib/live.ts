import { fmtInt } from './format.js';

// The masthead's "● Arc mainnet, live": grey "reconnecting" while the stream
// is down, "n s behind" once the newest block is more than 15 s old.
export type LiveState = { kind: 'live' } | { kind: 'behind'; seconds: number } | { kind: 'down' };

export const BEHIND_S = 15;

// The newest block time known: the stream's newest block, the hello's, or the
// stats' headT. While a backfilling archive sends few blocks, headT keeps the
// state honest between them.
export function newestTime(...times: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const t of times) if (t != null && (best === null || t > best)) best = t;
  return best;
}

// "n s", "n min", "n h" or "n days" behind, whichever reads best.
export function lagText(seconds: number): string {
  const g = (n: number): string => fmtInt(Math.round(n));
  if (seconds < 120) return `${g(seconds)} s behind`;
  if (seconds < 7200) return `${g(seconds / 60)} min behind`;
  if (seconds < 48 * 3600) return `${g(seconds / 3600)} h behind`;
  return `${g(seconds / 86400)} days behind`;
}

export function liveState(newestBlockTime: number | null, nowMs: number, open = true): LiveState {
  if (!open) return { kind: 'down' };
  if (newestBlockTime === null) return { kind: 'live' };
  const lag = Math.round(nowMs / 1000 - newestBlockTime);
  return lag > BEHIND_S ? { kind: 'behind', seconds: lag } : { kind: 'live' };
}
