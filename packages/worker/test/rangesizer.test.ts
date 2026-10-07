import { describe, expect, it } from 'vitest';
import { GROW_AFTER, RangeSizer } from '../src/rangesizer.js';

describe('RangeSizer', () => {
  it('halves on a cap, never below 1', () => {
    const s = new RangeSizer(1000);
    expect(s.shrink()).toBe(true);
    expect(s.size).toBe(500);
    while (s.shrink()) { /* down to 1 */ }
    expect(s.size).toBe(1);
    expect(s.shrink()).toBe(false);
  });

  it(`doubles back after ${GROW_AFTER} clean ranges, up to the configured size`, () => {
    const s = new RangeSizer(100);
    s.shrink(); // 50
    for (let i = 0; i < GROW_AFTER - 1; i++) expect(s.succeeded()).toBe(false);
    expect(s.succeeded()).toBe(true);
    expect(s.size).toBe(100);
    for (let i = 0; i < 3 * GROW_AFTER; i++) s.succeeded();
    expect(s.size).toBe(100);
  });

  it('a cap resets the run of clean ranges', () => {
    const s = new RangeSizer(100);
    s.shrink(); // 50
    for (let i = 0; i < GROW_AFTER - 1; i++) s.succeeded();
    s.shrink(); // 25
    expect(s.succeeded()).toBe(false);
    expect(s.size).toBe(25);
  });
});
