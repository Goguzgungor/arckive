export interface ReleaseInput {
  cursor: number | null; // the worker's _cursor
  insightsCursor: number | null | undefined; // undefined: lanes are not on; null: on, not started
  heldThrough: number | null; // the newest block whose _ingested_at is older than LANE_HOLD_MS
}

// How far the tape may go. A row waits for its lane — up to the insights
// cursor — but at most LANE_HOLD_MS: a block older than the hold goes out
// without it. Never past the worker's cursor. With lanes not switched on
// there is nothing to wait for. (At ~14 movements a second a 32-row tape
// turns over every ~2 s; a lane filled in later would land on rows no one sees.)
export function releaseTo(i: ReleaseInput): number | null {
  if (i.cursor === null) return null;
  if (i.insightsCursor === undefined) return i.cursor;
  const lanes = Math.min(i.insightsCursor ?? -1, i.cursor);
  const held = Math.min(i.heldThrough ?? -1, i.cursor);
  return Math.max(lanes, held);
}
