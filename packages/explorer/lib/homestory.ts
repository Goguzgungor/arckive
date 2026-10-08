import { fmtInt, fmtWhole, pct } from './format.js';
import { LANES_ALWAYS, LANE_ORDER, laneMeta } from './lanes.js';
import type { Part } from './parts.js';
import type { StatsMsg } from './types.js';

const laned = (s: StatsMsg): number => Object.values(s.lanes).reduce((a, b) => a + b, 0);

// "Insights down": more than half of the last minute went out without a lane.
export function lanesPaused(s: StatsMsg | null): boolean {
  return !!s && s.count > 0 && laned(s) * 2 < s.count;
}

export function homeHeadline(s: StatsMsg | null): Part[] {
  if (!s || s.count === 0) return ['Listening to Arc…'];
  const parts: Part[] = [
    'In the last minute ', { b: `${fmtWhole(s.usdc)} USDC` }, ' moved across Arc in ', { b: fmtInt(s.count) },
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
