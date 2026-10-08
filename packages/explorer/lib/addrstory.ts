import { fmtAmount, fmtDay, fmtInt, unitsToDecimal } from './format.js';
import { LANE_ORDER, laneMeta } from './lanes.js';
import { nameOf } from './names.js';
import type { Part } from './parts.js';
import type { AddressTotals, DayBar } from './address.js';

export function topLane(lanes: Record<string, number>): string | null {
  let best: string | null = null;
  for (const lane of LANE_ORDER) {
    if (lane === 'uncertain') continue;
    const n = lanes[lane] ?? 0;
    if (n > 0 && (best === null || n > (lanes[best] ?? 0))) best = lane;
  }
  return best;
}

// Contract or wallet is not known without a call, so it is not claimed: a
// named contract is called by its name, anything else "This address".
export function addressHeadline(a: { address: string; totals: AddressTotals; topLane: string | null }): Part[] {
  const name = nameOf(a.address);
  const n = a.totals.inCount + a.totals.outCount;
  const parts: Part[] = [
    name ? { b: name } : 'This address',
    ' received ', { b: `${fmtAmount(unitsToDecimal(a.totals.inValue))} USDC` },
    ' and sent ', { b: `${fmtAmount(unitsToDecimal(a.totals.outValue))} USDC` },
    ' across ', { b: fmtInt(n) }, n === 1 ? ' movement' : ' movements',
  ];
  if (a.totals.firstDay) parts.push(` since ${fmtDay(a.totals.firstDay)}`);
  if (a.topLane) parts.push(' — mostly ', { b: laneMeta(a.topLane).plural }, '.');
  else parts.push('.');
  return parts;
}

export function netOf(t: AddressTotals): string {
  return unitsToDecimal(BigInt(t.inValue) - BigInt(t.outValue));
}

export interface ChartBar {
  day: string;
  x: number;
  inH: number;
  outH: number;
}

const DAY_MS = 86_400_000;

// One slot per UTC day from the first to the last, empty days included;
// heights on a square-root scale so a quiet day still shows beside a busy one.
// Floats are fine here: these are pixels, not amounts.
export function chartBars(daysIn: DayBar[], width = 840, half = 82): { bars: ChartBar[]; barWidth: number } {
  if (!daysIn.length) return { bars: [], barWidth: 0 };
  const byDay = new Map(daysIn.map((d) => [d.day, d]));
  const start = Date.parse(`${daysIn[0]!.day}T00:00:00Z`);
  const end = Date.parse(`${daysIn.at(-1)!.day}T00:00:00Z`);
  const slots = Math.round((end - start) / DAY_MS) + 1;
  const value = (s: string): number => Number(unitsToDecimal(s));
  const top = Math.max(...daysIn.flatMap((d) => [value(d.inValue), value(d.outValue)]), 0);
  const scale = (v: number): number => (top > 0 ? Math.sqrt(v / top) * half : 0);
  const pitch = (width - 40) / slots;
  const barWidth = Math.max(1, pitch - Math.min(2, pitch / 4));
  const bars = Array.from({ length: slots }, (_, i): ChartBar => {
    const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const d = byDay.get(day);
    return { day, x: 20 + i * pitch, inH: d ? scale(value(d.inValue)) : 0, outH: d ? scale(value(d.outValue)) : 0 };
  });
  return { bars, barWidth };
}
