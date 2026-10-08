import { describe, expect, it } from 'vitest';
import { RollingWindow, type WindowMove } from '../lib/window.js';

const E18 = 10n ** 18n;
const mv = (tx: string, li: number, whole: number, lane: string | null): WindowMove => ({
  tx, li, from: '0xa', to: '0xb', value: String(whole), raw: BigInt(whole) * E18, lane,
});

describe('RollingWindow', () => {
  it('counts the last 60 s of block time, summing exactly', () => {
    const w = new RollingWindow();
    w.add({ n: 1, t: 1000, moves: [mv('0x1', 0, 5, 'swap')] });
    w.add({ n: 2, t: 1030, moves: [mv('0x2', 0, 7, 'payment'), mv('0x2', 1, 1, null)] });
    let s = w.stats(123);
    expect(s).toMatchObject({ count: 3, usdc: '13', lanes: { swap: 1, payment: 1 }, now: 123 });
    w.add({ n: 3, t: 1061, moves: [mv('0x3', 0, 2, 'swap')] });
    s = w.stats(124);
    expect(s).toMatchObject({ count: 3, usdc: '10', lanes: { payment: 1, swap: 1 } });
  });

  it('keeps the newest block time that carried a movement, past the minute it counts', () => {
    const w = new RollingWindow();
    expect(w.stats(0).headT).toBeNull();
    w.add({ n: 1, t: 1000, moves: [mv('0x1', 0, 5, 'swap')] });
    expect(w.stats(0).headT).toBe(1000);
    w.add({ n: 2, t: 1500, moves: [] });
    expect(w.stats(0).headT).toBe(1000);
    w.add({ n: 3, t: 1600, moves: [mv('0x3', 0, 1, null)] });
    expect(w.stats(0)).toMatchObject({ headT: 1600, count: 1 });
  });

  it('lists the five largest movements, one per transaction', () => {
    const w = new RollingWindow();
    w.add({ n: 1, t: 1, moves: [mv('0xa', 0, 100, 'swap'), mv('0xa', 1, 90, 'swap'), mv('0xb', 0, 50, null)] });
    w.add({ n: 2, t: 2, moves: [1, 2, 3, 4, 5].map((i) => mv(`0xc${i}`, 0, i, 'payment')) });
    const largest = w.stats(0).largest;
    expect(largest.map((m) => [m.tx, m.value])).toEqual([['0xa', '100'], ['0xb', '50'], ['0xc5', '5'], ['0xc4', '4'], ['0xc3', '3']]);
    expect(largest[0]).toMatchObject({ n: 1, t: 1 });
    expect(largest[0]).not.toHaveProperty('raw');
  });

  it('rates per second over the time it has seen, up to a minute', () => {
    const w = new RollingWindow();
    w.add({ n: 1, t: 100, moves: [mv('0x1', 0, 1, null)] });
    w.add({ n: 2, t: 110, moves: Array.from({ length: 19 }, (_, i) => mv('0x2', i, 1, null)) });
    expect(w.stats(0).perSec).toBe(2);
  });
});
