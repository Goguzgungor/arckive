export interface PacerOptions {
  gapsKept: number;
  minGapMs: number;
  maxGapMs: number;
  defaultGapMs: number;
  maxBacklogMs: number;
  drainMs: number;
  maxQueue: number;
}

export const PACING: PacerOptions = { gapsKept: 20, minGapMs: 100, maxGapMs: 2000, defaultGapMs: 500, maxBacklogMs: 3000, drainMs: 1000, maxQueue: 128 };

// Spreads each block's rows over the time until the next block is expected
// (the median gap of the last 20, ~0.5 s on Arc), so the tape flows instead
// of jumping. A backlog over 3 s is drained within a second rather than
// delayed further; while paused (the pointer or focus on the tape) nothing
// enters and the rows wait.
export class Pacer<T> {
  #q: Array<{ item: T; due: number }> = [];
  #gaps: number[] = [];
  #last: number | null = null;
  #paused = false;
  #skipped = 0;

  constructor(private readonly o: PacerOptions = PACING) {}

  interval(): number {
    if (!this.#gaps.length) return this.o.defaultGapMs;
    const s = [...this.#gaps].sort((a, b) => a - b);
    const mid = s.length >> 1;
    const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    return Math.min(this.o.maxGapMs, Math.max(this.o.minGapMs, median));
  }

  push(items: readonly T[], now: number): void {
    if (this.#last !== null) {
      this.#gaps.push(now - this.#last);
      if (this.#gaps.length > this.o.gapsKept) this.#gaps.shift();
    }
    this.#last = now;
    if (!items.length) return;
    const step = this.interval() / items.length;
    const start = Math.max(now, this.#q.at(-1)?.due ?? now);
    items.forEach((item, i) => this.#q.push({ item, due: start + step * i }));
    // A hidden tab runs no animation frames while the stream keeps delivering,
    // and a parked pointer pauses the tape: the tape shows 32 rows, so keep
    // only the newest few multiples of that and count the rest as skipped.
    if (this.#q.length > this.o.maxQueue) {
      const drop = this.#q.length - this.o.maxQueue;
      this.#q.splice(0, drop);
      this.#skipped += drop;
    }
    if (!this.#paused && this.#q.at(-1)!.due - now > this.o.maxBacklogMs) this.#respread(now);
  }

  #respread(now: number): void {
    const step = this.o.drainMs / this.#q.length;
    this.#q.forEach((e, i) => {
      e.due = now + step * i;
    });
  }

  take(now: number): T[] {
    if (this.#paused) return [];
    let i = 0;
    while (i < this.#q.length && this.#q[i]!.due <= now) i++;
    return this.#q.splice(0, i).map((e) => e.item);
  }

  pause(): void {
    this.#paused = true;
  }

  resume(now: number): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#skipped = 0; // those rows are gone; the tape is live again
    if (this.#q.length) this.#respread(now);
  }

  clear(): void {
    this.#q = [];
    this.#skipped = 0;
  }

  get waiting(): number {
    return this.#q.length + this.#skipped;
  }

  get isPaused(): boolean {
    return this.#paused;
  }
}
