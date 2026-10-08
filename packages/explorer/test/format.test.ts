import { describe, expect, it } from 'vitest';
import {
  dayOf, fmtAmount, fmtBytes, fmtDateLong, fmtDateTime, fmtDay, fmtFee, fmtInt, fmtSigned, fmtStamp, fmtTime,
  fmtWhole, pct, shortAddr, shortHash, unitsToDecimal,
} from '../lib/format.js';

describe('unitsToDecimal', () => {
  it('turns 18-decimal integers into exact decimals', () => {
    expect(unitsToDecimal('476932500000000000000')).toBe('476.9325');
    expect(unitsToDecimal('0')).toBe('0');
    expect(unitsToDecimal('1')).toBe('0.000000000000000001');
    expect(unitsToDecimal(-476932500000000000000n)).toBe('-476.9325');
    expect(unitsToDecimal('1500000', 6)).toBe('1.5');
    expect(unitsToDecimal('42', 0)).toBe('42');
  });

  it('keeps a 78-digit numeric exact', () => {
    expect(unitsToDecimal(`1${'0'.repeat(77)}`)).toBe(`1${'0'.repeat(59)}`);
  });
});

describe('amounts', () => {
  it('shows two decimals with separators, rounding half up', () => {
    expect(fmtAmount('476.9325')).toBe('476.93');
    expect(fmtAmount('13763833.330793760056038261')).toBe('13,763,833.33');
    expect(fmtAmount('0.995')).toBe('1.00');
    expect(fmtAmount('1234567.005')).toBe('1,234,567.01');
    expect(fmtAmount('0')).toBe('0.00');
    expect(fmtAmount('-5.5')).toBe('−5.50');
  });

  it('shows a nonzero amount under a cent as <0.01', () => {
    expect(fmtAmount('0.0049')).toBe('<0.01');
    expect(fmtAmount('0.000000000000000001')).toBe('<0.01');
  });

  it('rounds the headline total to whole USDC', () => {
    expect(fmtWhole('13680.49')).toBe('13,680');
    expect(fmtWhole('13680.5')).toBe('13,681');
  });

  it('signs a net amount', () => {
    expect(fmtSigned('0.004')).toBe('+<0.01');
    expect(fmtSigned('-260.5')).toBe('−260.50');
    expect(fmtSigned('0')).toBe('0.00');
  });

  it('groups integers of any size', () => {
    expect(fmtInt(24787775)).toBe('24,787,775');
    expect(fmtInt(13763833330793760056038261n)).toBe('13,763,833,330,793,760,056,038,261');
    expect(fmtInt('999')).toBe('999');
  });

  it('formats a v4 fee and a share', () => {
    expect(fmtFee(2500)).toBe('0.25%');
    expect(fmtFee(100)).toBe('0.01%');
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBe(0);
  });
});

describe('times, in UTC', () => {
  const t = 1791405212; // 2026-10-07T20:33:32Z
  it('formats block times', () => {
    expect(fmtTime(t)).toBe('20:33:32');
    expect(fmtDateTime(t)).toBe('2026-10-07 20:33:32 UTC');
    expect(fmtStamp(t)).toBe('2026-10-07 20:33');
    expect(dayOf(t)).toBe('2026-10-07');
  });
  it('writes the dateline and days', () => {
    expect(fmtDateLong(new Date('2026-10-07T23:59:00Z'))).toBe('Wednesday, 7 October 2026');
    expect(fmtDay('2026-06-03')).toBe('3 June 2026');
  });
});

describe('short forms', () => {
  it('shortens addresses and hashes', () => {
    expect(shortAddr('0x5e2928212630ccd57bc53f0df428fb678c0da2b7')).toBe('0x5e29…a2b7');
    expect(shortHash('0x6c96ee62f2fcebe56264711c18d20e89bed338d4f055628313c9086f3add79e8')).toBe('0x6c96ee62…dd79e8');
  });
  it('writes database sizes', () => {
    expect(fmtBytes(13_200_000_000)).toBe('13.2 GB');
    expect(fmtBytes(8_790_000)).toBe('8.8 MB');
    expect(fmtBytes(512)).toBe('512 B');
  });
});
