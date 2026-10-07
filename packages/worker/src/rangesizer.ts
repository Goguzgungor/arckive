// The pipeline's working getLogs span. A provider cap halves it at once
// (floor 1); every GROW_AFTER clean ranges double it again, up to the
// configured batchBlocks, so a cap that was lifted is found again. Kept in
// memory only: after a restart the cap is found again in log2(batchBlocks)
// calls, which is cheaper than persisting a value that may be stale.
export const GROW_AFTER = 20;

export class RangeSizer {
  private current: number;
  private clean = 0;

  constructor(private readonly max: number) {
    this.current = max;
  }

  get size(): number {
    return this.current;
  }

  shrink(): boolean {
    if (this.current <= 1) return false;
    this.current = Math.max(1, Math.floor(this.current / 2));
    this.clean = 0;
    return true;
  }

  // true when the span grew
  succeeded(): boolean {
    if (this.current >= this.max) return false;
    if (++this.clean < GROW_AFTER) return false;
    this.current = Math.min(this.max, this.current * 2);
    this.clean = 0;
    return true;
  }
}
