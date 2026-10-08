import { describe, expect, it } from 'vitest';
import { helloPlan, homeHeadline, laneShares, lanesPaused } from '../lib/homestory.js';
import type { BlockMsg, StatsMsg } from '../lib/types.js';

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
  it('names the minute it counts when the tape is behind', () => {
    const at = Date.UTC(2026, 9, 8, 14, 7, 42) / 1000; // the newest block's time
    expect(homeHeadline(S({}), at).slice(0, 2)).toEqual(['In the minute to 14:07 UTC ', { b: '13,680 USDC' }]);
    expect(homeHeadline(S({}), null)[0]).toBe('In the last minute ');
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

describe('a hello on the tape', () => {
  const b = (n: number): BlockMsg => ({ n, t: 1000 + n, moves: [{ tx: '0x1', li: 0, from: '0xa', to: '0xb', value: '1', lane: null }] });
  it("takes the hello's newest block, even a lower one (a restarted server, a rewound worker)", () => {
    expect(helloPlan({ blocks: [b(5), b(9)], stats: null }, false)).toEqual({ newest: { n: 9, t: 1009 }, replace: true });
  });
  it('forgets the newest block on an empty hello but keeps the rows on screen', () => {
    expect(helloPlan({ blocks: [], stats: null }, false)).toEqual({ newest: null, replace: false });
  });
  it('keeps the rows of a paused tape', () => {
    expect(helloPlan({ blocks: [b(5)], stats: null }, true)).toEqual({ newest: { n: 5, t: 1005 }, replace: false });
  });
});
