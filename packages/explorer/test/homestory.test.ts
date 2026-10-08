import { describe, expect, it } from 'vitest';
import { homeHeadline, laneShares, lanesPaused } from '../lib/homestory.js';
import type { StatsMsg } from '../lib/types.js';

const S = (over: Partial<StatsMsg>): StatsMsg => ({ count: 161, usdc: '13680.49', perSec: 2.7, lanes: { swap: 123, payment: 30 }, largest: [], now: 0, ...over });

describe('home headline', () => {
  it('writes the minute from live numbers', () => {
    expect(homeHeadline(S({}))).toEqual([
      'In the last minute ', { b: '13,680 USDC' }, ' moved across Arc in ', { b: '161' }, ' movements', '; ', { b: '123' }, ' of them were swaps.',
    ]);
  });
  it('leaves lanes out while they are paused', () => {
    expect(homeHeadline(S({ lanes: { swap: 3 } })).at(-1)).toBe('.');
    expect(lanesPaused(S({ lanes: { swap: 3 } }))).toBe(true);
    expect(lanesPaused(S({}))).toBe(false);
  });
  it('waits for the first numbers', () => {
    expect(homeHeadline(null)).toEqual(['Listening to Arc…']);
    expect(homeHeadline(S({ count: 0, usdc: '0', lanes: {} }))).toEqual(['Listening to Arc…']);
  });
  it('agrees in number', () => {
    expect(homeHeadline(S({ count: 1, lanes: { swap: 1 } }))).toEqual([
      'In the last minute ', { b: '13,680 USDC' }, ' moved across Arc in ', { b: '1' }, ' movement', '; ', { b: '1' }, ' of them was a swap.',
    ]);
  });
});

describe('lane shares', () => {
  it("lists the usual lanes in core's order, and others when present", () => {
    const shares = laneShares(S({ lanes: { swap: 123, payment: 30, uncertain: 8 } }));
    expect(shares.map((s) => s.lane)).toEqual(['swap', 'bridge', 'liquidity', 'vault', 'lending', 'signed_payment', 'payment', 'spam', 'issuance', 'uncertain']);
    expect(shares[0]).toEqual({ lane: 'swap', label: 'Swap', ink: '#7442d1', pct: 76 });
  });
});
