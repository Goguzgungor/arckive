// The masthead's "● Arc mainnet, live": grey "reconnecting" while the stream
// is down, "n s behind" once the newest block is more than 15 s old.
export type LiveState = { kind: 'live' } | { kind: 'behind'; seconds: number } | { kind: 'down' };

export const BEHIND_S = 15;

export function liveState(newestBlockTime: number | null, nowMs: number, open = true): LiveState {
  if (!open) return { kind: 'down' };
  if (newestBlockTime === null) return { kind: 'live' };
  const lag = Math.round(nowMs / 1000 - newestBlockTime);
  return lag > BEHIND_S ? { kind: 'behind', seconds: lag } : { kind: 'live' };
}
