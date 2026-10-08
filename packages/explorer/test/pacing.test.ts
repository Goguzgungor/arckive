import { describe, expect, it } from 'vitest';
import { PACING, Pacer } from '../lib/pacing.js';

describe('Pacer', () => {
  it("spreads a block's rows over the expected gap", () => {
    const p = new Pacer<string>();
    p.push(['a', 'b', 'c', 'd', 'e'], 0); // no gaps seen yet: 500 ms
    expect(p.take(0)).toEqual(['a']);
    expect(p.take(99)).toEqual([]);
    expect(p.take(100)).toEqual(['b']);
    expect(p.take(450)).toEqual(['c', 'd', 'e']);
  });

  it('expects the median of the last gaps between blocks, within bounds', () => {
    const p = new Pacer<number>();
    p.push([], 0);
    p.push([], 400);
    p.push([], 1000);
    expect(p.interval()).toBe(500);
    p.push([], 6000);
    expect(p.interval()).toBe(600);
    const q = new Pacer<number>();
    q.push([], 0);
    q.push([], 10);
    expect(q.interval()).toBe(100);
  });

  it('drains a backlog over 3 s within a second instead of falling further behind', () => {
    // every block spread over 2 s: the second one would end 3.8 s out
    const p = new Pacer<number>({ ...PACING, minGapMs: 2000, maxGapMs: 2000, defaultGapMs: 2000 });
    p.push(Array.from({ length: 20 }, (_, j) => j), 0);
    p.push(Array.from({ length: 20 }, (_, j) => 20 + j), 0);
    expect(p.waiting).toBe(40);
    expect(p.take(1000)).toEqual(Array.from({ length: 40 }, (_, j) => j));
  });

  it('holds rows while paused, counts them, and drains them on resume', () => {
    const p = new Pacer<number>();
    p.pause();
    p.push([1, 2, 3], 0);
    expect(p.take(10_000)).toEqual([]);
    expect(p.waiting).toBe(3);
    expect(p.isPaused).toBe(true);
    p.resume(10_000);
    expect(p.take(10_000)).toEqual([1]);
    expect(p.take(11_000)).toEqual([2, 3]);
  });

  it('keeps arrival order across blocks', () => {
    const p = new Pacer<number>();
    p.push([1, 2], 0);
    p.push([3], 100);
    expect(p.take(5000)).toEqual([1, 2, 3]);
  });

  it('bounds the queue: a long pause keeps the newest rows and counts the rest', () => {
    const p = new Pacer<number>();
    p.pause();
    p.push(Array.from({ length: 300 }, (_, j) => j), 0);
    expect(p.waiting).toBe(300);
    p.resume(10_000);
    const out = p.take(1_000_000);
    expect(out).toHaveLength(PACING.maxQueue);
    expect(out).toEqual(Array.from({ length: PACING.maxQueue }, (_, j) => 300 - PACING.maxQueue + j));
    expect(p.waiting).toBe(0);
  });

  it('never queues more than maxQueue in a long unpaused burst', () => {
    const p = new Pacer<number>();
    for (let b = 0; b < 50; b++) p.push(Array.from({ length: 20 }, (_, j) => b * 20 + j), b);
    expect(p.take(1_000_000).length).toBeLessThanOrEqual(PACING.maxQueue);
  });
});
