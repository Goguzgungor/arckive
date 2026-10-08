import { fmtInt, fmtTime, fmtWhole, pct } from './format.js';
import { LANES_ALWAYS, LANE_ORDER, laneMeta } from './lanes.js';
import type { Part } from './parts.js';
import type { Hello, StatsMsg } from './types.js';

const laned = (s: StatsMsg): number => Object.values(s.lanes).reduce((a, b) => a + b, 0);

// "Insights down": more than half of the last minute went out without a lane.
export function lanesPaused(s: StatsMsg | null): boolean {
  return !!s && s.count > 0 && laned(s) * 2 < s.count;
}

// behindAt: the newest block's time while the tape is behind. The rolling
// minute is the chain's last minute, not the clock's: a tape a minute behind
// must not call it "the last minute".
export function homeHeadline(s: StatsMsg | null, behindAt: number | null = null): Part[] {
  if (!s || s.count === 0) return ['Listening to Arc…'];
  const lead = behindAt === null ? 'In the last minute ' : `In the minute to ${fmtTime(behindAt).slice(0, 5)} UTC `;
  const parts: Part[] = [
    lead, { b: `${fmtWhole(s.usdc)} USDC` }, ' moved across Arc in ', { b: fmtInt(s.count) },
    s.count === 1 ? ' movement' : ' movements',
  ];
  if (lanesPaused(s)) return [...parts, '.'];
  const swaps = s.lanes['swap'] ?? 0;
  return [...parts, '; ', { b: fmtInt(swaps) }, swaps === 1 ? ' of them was a swap.' : ' of them were swaps.'];
}

export interface LaneShare {
  lane: string;
  label: string;
  ink: string;
  pct: number;
}

export function laneShares(s: StatsMsg | null): LaneShare[] {
  const total = s?.count ?? 0;
  return LANE_ORDER.filter((l) => LANES_ALWAYS.includes(l) || (s?.lanes[l] ?? 0) > 0).map((lane) => {
    const m = laneMeta(lane);
    return { lane, label: m.label, ink: m.ink, pct: pct(s?.lanes[lane] ?? 0, total) };
  });
}

export interface HelloPlan {
  newest: { n: number; t: number } | null; // blocks after this one are new
  replace: boolean; // show the hello's rows in place of the tape's
}

// What a hello does to the tape. The newest block becomes the hello's, even a
// lower one (a restarted server, a rewound worker): keeping the old one would
// drop every block below it for good. An empty hello (a server still booting)
// clears it and leaves the rows on screen; a paused tape — a pointer resting
// on the row it is about to click — keeps its rows too.
export function helloPlan(h: Hello, paused: boolean): HelloPlan {
  const last = h.blocks.at(-1);
  return { newest: last ? { n: last.n, t: last.t } : null, replace: !!last && !paused };
}
