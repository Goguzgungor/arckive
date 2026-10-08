import { describe, expect, it } from 'vitest';
import { addressHeadline, barTitle, chartBars, netOf, topLane } from '../lib/addrstory.js';
import type { AddressTotals } from '../lib/address.js';

const T = (over: Partial<AddressTotals> = {}): AddressTotals => ({
  inValue: '48211070000000000000000', outValue: '47950000000000000000000', inCount: 700, outCount: 514,
  firstDay: '2026-06-03', lastDay: '2026-10-07', ...over,
});

describe('address sentences', () => {
  it('writes the headline without claiming wallet or contract', () => {
    expect(addressHeadline({ address: `0x${'ab'.repeat(20)}`, totals: T(), topLane: 'payment' })).toEqual([
      'This address', ' received ', { b: '48,211.07 USDC' }, ' and sent ', { b: '47,950.00 USDC' },
      ' across ', { b: '1,214' }, ' movements', ' since 3 June 2026', ' — mostly ', { b: 'payments' }, '.',
    ]);
  });

  it('names a named contract and drops the lane clause when there is none', () => {
    const parts = addressHeadline({ address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', totals: T({ inCount: 1, outCount: 0 }), topLane: null });
    expect(parts[0]).toEqual({ b: 'Uniswap v4 Pools' });
    expect(parts).toContain(' movement');
    expect(parts.at(-1)).toBe('.');
  });

  it('picks the busiest lane, never "uncertain", ties in lane order', () => {
    expect(topLane({ payment: 3, swap: 3 })).toBe('swap');
    expect(topLane({ uncertain: 9, payment: 1 })).toBe('payment');
    expect(topLane({})).toBeNull();
  });

  it('nets in minus out exactly', () => {
    expect(netOf(T())).toBe('261.07');
    expect(netOf(T({ inValue: '0', outValue: '5' }))).toBe('-0.000000000000000005');
  });
});

describe('chartBars', () => {
  it('draws one slot per day, gaps included, on a square-root scale', () => {
    const E18 = '000000000000000000';
    const { bars, barWidth } = chartBars([
      { day: '2026-10-01', inValue: `100${E18}`, outValue: '0' },
      { day: '2026-10-03', inValue: `25${E18}`, outValue: `100${E18}` },
    ], 840, 80);
    expect(bars.map((b) => b.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(bars[0]).toMatchObject({ inH: 80, outH: 0 });
    expect(bars[1]).toMatchObject({ inH: 0, outH: 0 });
    expect(bars[2]).toMatchObject({ inH: 40, outH: 80 });
    expect(barWidth).toBeGreaterThan(0);
  });
  it('draws nothing for no days', () => {
    expect(chartBars([]).bars).toEqual([]);
  });

  it('keeps a nonzero day visible, caps the bar width and centres bars in their slots', () => {
    const { bars, barWidth } = chartBars([
      { day: '2026-10-07', inValue: '2972070000000000000000', outValue: '1' },
      { day: '2026-10-08', inValue: '0', outValue: '4127330000000000000000' },
    ], 840, 82);
    // two days: slots of 400 px must not draw 400 px slabs
    expect(barWidth).toBe(24);
    expect(bars[0]!.x).toBe(20 + (400 - 24) / 2);
    expect(bars[1]!.x).toBe(20 + 400 + (400 - 24) / 2);
    // one wei out still shows
    expect(bars[0]!.outH).toBe(1);
    expect(bars[1]!.inH).toBe(0);
  });

  it("titles a bar with the day's amounts in and out", () => {
    const { bars } = chartBars([
      { day: '2026-10-05', inValue: '2972070000000000000000', outValue: '4127330000000000000000' },
      { day: '2026-10-07', inValue: '5', outValue: '0' },
    ]);
    expect(bars.map(barTitle)).toEqual([
      '2026-10-05 · in 2,972.07 USDC · out 4,127.33 USDC',
      '2026-10-06 · in 0.00 USDC · out 0.00 USDC',
      '2026-10-07 · in <0.01 USDC · out 0.00 USDC',
    ]);
  });
});
