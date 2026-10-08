import { describe, expect, it } from 'vitest';
import { addressHeadline, chartBars, netOf, topLane } from '../lib/addrstory.js';
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
});
