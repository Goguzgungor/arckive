export interface PacerOptions {
  gapsKept: number;
  minGapMs: number;
  maxGapMs: number;
  defaultGapMs: number;
  maxBacklogMs: number;
  drainMs: number;
  maxQueue: number;
  coalesceMs: number;
}

export const PACING: PacerOptions = {
  gapsKept: 20, minGapMs: 100, maxGapMs: 2000, defaultGapMs: 500, maxBacklogMs: 3000, drainMs: 1000, maxQueue: 128, coalesceMs: 50,
};

interface Entry<T> {
  item: T;
  due: number;
  arrival: number; // the arrival it came in
  idx: number; // its place in that arrival
}

interface Arrival {
  id: number;
  start: number; // its first push
  last: number; // its latest push
  base: number; // when its first row is due
  count: number; // rows in all its pushes
}

// Spreads each arrival's rows over the time until the next one is expected
// (the median gap of the last 20, ~0.5 s on Arc), so the tape flows instead
// of jumping. An arrival is every push less than 50 ms after the one before:
// the worker commits every ~1 s covering 2–3 blocks, which land within
// milliseconds of each other, and timing those as gaps of their own would
// collapse the interval to its floor and run the tape in jumps. A backlog
// over 3 s is drained within a second rather than delayed further; while
// paused (the pointer or focus on the tape) nothing enters and the rows wait.
export class Pacer<T> {
  #q: Array<Entry<T>> = [];
  #gaps: number[] = [];
  #arrival: Arrival | null = null;
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
    let a = this.#arrival;
    if (a && now - a.last < this.o.coalesceMs) {
      a.last = now;
    } else {
      if (a) {
        this.#gaps.push(now - a.start);
        if (this.#gaps.length > this.o.gapsKept) this.#gaps.shift();
      }
      a = { id: (a?.id ?? 0) + 1, start: now, last: now, base: Math.max(now, this.#q.at(-1)?.due ?? now), count: 0 };
      this.#arrival = a;
    }
    if (!items.length) return;
    for (const item of items) this.#q.push({ item, due: 0, arrival: a.id, idx: a.count++ });
    // all of the arrival's rows over one interval from its start; the ones
    // already shown keep their place, the rest close up
    const step = this.interval() / a.count;
    for (let i = this.#q.length - 1; i >= 0 && this.#q[i]!.arrival === a.id; i--) this.#q[i]!.due = a.base + step * this.#q[i]!.idx;
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
