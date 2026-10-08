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

// The rollup lags the worker by up to a round (2 s) in steady state; further
// behind, the totals say how far they reach.
const ROLLUP_SLACK = 120;

export function rollupBehind(rolledTo: number | null, headBlock: number | null): boolean {
  return rolledTo !== null && headBlock !== null && rolledTo < headBlock - ROLLUP_SLACK;
}

// An address with no totals. A known address (it is in the worker's
// _addresses) whose rows the rollup has not reached yet must not read as
// one that never moved USDC; once the rollup has caught up, it is one (it
// appears in pool events only).
export function emptyAddressText(known: boolean, rolledTo: number | null, headBlock: number | null): string {
  if (known && rolledTo === null) return 'Totals are still being added.';
  if (known && rollupBehind(rolledTo, headBlock)) return `Totals are still being added (up to block ${fmtInt(rolledTo!)}).`;
  return 'No USDC movement for this address since 2026-05-15.';
}

export function netOf(t: AddressTotals): string {
  return unitsToDecimal(BigInt(t.inValue) - BigInt(t.outValue));
}

export interface ChartBar {
  day: string;
  x: number;
  inH: number;
  outH: number;
  inValue: string; // the day's USDC in, exact decimal
  outValue: string;
}

const DAY_MS = 86_400_000;
// a history of one or two days must draw bars, not slabs
const MAX_BAR = 24;

// One slot per UTC day from the first to the last, empty days included;
// heights on a square-root scale so a quiet day still shows beside a busy one,
// and any nonzero day at least 1 px. Bars are centred in their slots.
// Floats are fine here: these are pixels, not amounts.
export function chartBars(daysIn: DayBar[], width = 840, half = 82): { bars: ChartBar[]; barWidth: number } {
  if (!daysIn.length) return { bars: [], barWidth: 0 };
  const byDay = new Map(daysIn.map((d) => [d.day, d]));
  const start = Date.parse(`${daysIn[0]!.day}T00:00:00Z`);
  const end = Date.parse(`${daysIn.at(-1)!.day}T00:00:00Z`);
  const slots = Math.round((end - start) / DAY_MS) + 1;
  const value = (s: string): number => Number(unitsToDecimal(s));
  const top = Math.max(...daysIn.flatMap((d) => [value(d.inValue), value(d.outValue)]), 0);
  const scale = (v: number): number => (top > 0 && v > 0 ? Math.max(1, Math.sqrt(v / top) * half) : 0);
  const pitch = (width - 40) / slots;
  const barWidth = Math.min(MAX_BAR, Math.max(1, pitch - Math.min(2, pitch / 4)));
  const bars = Array.from({ length: slots }, (_, i): ChartBar => {
    const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const d = byDay.get(day);
    return {
      day,
      x: 20 + i * pitch + (pitch - barWidth) / 2,
      inH: d ? scale(value(d.inValue)) : 0,
      outH: d ? scale(value(d.outValue)) : 0,
      inValue: unitsToDecimal(d?.inValue ?? '0'),
      outValue: unitsToDecimal(d?.outValue ?? '0'),
    };
  });
  return { bars, barWidth };
}

// what a pointer resting on a day reads
export function barTitle(b: ChartBar): string {
  return `${b.day} · in ${fmtAmount(b.inValue)} USDC · out ${fmtAmount(b.outValue)} USDC`;
}
