import { unitsToDecimal } from './format.js';
import type { Largest, Move, StatsMsg } from './types.js';

export interface WindowMove extends Move {
  raw: bigint; // the value in wei, for exact sums and comparisons
}

export interface WindowBlock {
  n: number;
  t: number;
  moves: WindowMove[];
}

type Held = WindowMove & { n: number; t: number };

// The tape's last minute, by block time rather than the clock: a tailer
// catching up after a stall still counts the minute the chain had.
export class RollingWindow {
  #moves: Held[] = [];
  #newest = 0;
  #first: number | null = null;
  #head: number | null = null; // newest block time that carried a movement, kept

  constructor(private readonly spanSec = 60) {}

  add(b: WindowBlock): void {
    for (const m of b.moves) this.#moves.push({ ...m, n: b.n, t: b.t });
    this.#newest = Math.max(this.#newest, b.t);
    if (b.moves.length) this.#head = Math.max(this.#head ?? 0, b.t);
    this.#first ??= b.t;
    const floor = this.#newest - this.spanSec;
    let drop = 0;
    while (drop < this.#moves.length && this.#moves[drop]!.t <= floor) drop++;
    if (drop) this.#moves.splice(0, drop);
  }

  stats(now: number): StatsMsg {
    let sum = 0n;
    const lanes: Record<string, number> = {};
    const perTx = new Map<string, Held>();
    for (const m of this.#moves) {
      sum += m.raw;
      if (m.lane) lanes[m.lane] = (lanes[m.lane] ?? 0) + 1;
      const best = perTx.get(m.tx);
      if (!best || m.raw > best.raw) perTx.set(m.tx, m);
    }
    const largest: Largest[] = [...perTx.values()]
      .sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0))
      .slice(0, 5)
      .map((m) => {
        const out: Largest = { tx: m.tx, li: m.li, from: m.from, to: m.to, value: m.value, lane: m.lane, n: m.n, t: m.t };
        if (m.fromName) out.fromName = m.fromName;
        if (m.toName) out.toName = m.toName;
        return out;
      });
    const seen = this.#first === null ? 1 : this.#newest - this.#first;
    const span = Math.max(1, Math.min(this.spanSec, seen));
    return { count: this.#moves.length, usdc: unitsToDecimal(sum), perSec: Math.round((this.#moves.length / span) * 10) / 10, lanes, largest, headT: this.#head, now };
  }
}
