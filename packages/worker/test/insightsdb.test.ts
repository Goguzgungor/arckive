import { describe, expect, it } from 'vitest';
import { DictionaryMissError, needId } from '../src/insightsdb.js';

describe('needId', () => {
  it('returns a known id', () => {
    expect(needId(new Map([['k', 7]]), 'k', 'label', {})).toBe(7);
  });

  it('throws a named error naming the missing key parts instead of yielding undefined', () => {
    expect(() => needId(new Map(), 'k', 'label', { lane: 'dex', sentence_id: 3 })).toThrow(DictionaryMissError);
    expect(() => needId(new Map(), 'k', 'label', { lane: 'dex', sentence_id: 3 })).toThrow(/label id missing.*"lane":"dex".*"sentence_id":3/);
  });
});
