import { describe, expect, it } from 'vitest';
import { releaseTo } from '../lib/release.js';

describe('releaseTo', () => {
  it('releases everything the worker wrote when lanes are not on', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: undefined, heldThrough: null })).toBe(100);
  });
  it('releases up to the insights cursor', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: 95, heldThrough: 90 })).toBe(95);
  });
  it('releases blocks whose hold ran out even without their lanes', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: 80, heldThrough: 92 })).toBe(92);
  });
  it('never passes the worker cursor', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: 120, heldThrough: 130 })).toBe(100);
  });
  it('waits while lanes have not started and nothing is old enough', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: null, heldThrough: null })).toBe(-1);
  });
  it('has nothing to release before the worker writes a cursor', () => {
    expect(releaseTo({ cursor: null, insightsCursor: 5, heldThrough: 5 })).toBeNull();
  });
});
