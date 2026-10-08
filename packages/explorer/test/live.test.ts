import { describe, expect, it } from 'vitest';
import { lagText, liveState, newestTime } from '../lib/live.js';

describe('liveState', () => {
  const now = 1_000_000 * 1000;
  it('is live within 15 s of the newest block', () => {
    expect(liveState(1_000_000 - 15, now)).toEqual({ kind: 'live' });
    expect(liveState(null, now)).toEqual({ kind: 'live' });
  });
  it('says how far behind it is past 15 s', () => {
    expect(liveState(1_000_000 - 42, now)).toEqual({ kind: 'behind', seconds: 42 });
  });
  it('says reconnecting while the stream is down', () => {
    expect(liveState(1_000_000, now, false)).toEqual({ kind: 'down' });
  });
});

describe('newestTime', () => {
  it('takes the newest known time, ignoring unknowns', () => {
    expect(newestTime(null, undefined)).toBeNull();
    expect(newestTime(100, null, 250, 200)).toBe(250);
  });
});

describe('lagText', () => {
  it('picks the unit that reads best', () => {
    expect(lagText(42)).toBe('42 s behind');
    expect(lagText(119)).toBe('119 s behind');
    expect(lagText(120)).toBe('2 min behind');
    expect(lagText(7199)).toBe('120 min behind');
    expect(lagText(7200)).toBe('2 h behind');
    expect(lagText(48 * 3600 - 1)).toBe('48 h behind');
    expect(lagText(6_298_299)).toBe('73 days behind');
    expect(lagText(1_000_000 * 86400 / 1)).toBe('1,000,000 days behind');
  });
});
