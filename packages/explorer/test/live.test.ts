import { describe, expect, it } from 'vitest';
import { liveState } from '../lib/live.js';

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
