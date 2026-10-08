import { describe, expect, it } from 'vitest';
import { LANES } from '@arckive/core';
import { LANE_META, LANE_ORDER, LANES_ALWAYS, laneMeta } from '../lib/lanes.js';
import { NAMES, nameOf } from '../lib/names.js';

describe('lanes', () => {
  it("starts with core's LANES in their measured order, then the ruled lanes", () => {
    const model = Object.keys(LANES);
    expect(LANE_ORDER.slice(0, model.length)).toEqual(model);
    expect(LANE_ORDER.slice(model.length)).toEqual(['issuance', 'uncertain', 'no_transfer']);
  });

  it('has a label, ink and plural for every lane', () => {
    for (const lane of LANE_ORDER) expect(LANE_META[lane], lane).toMatchObject({ label: expect.any(String), ink: expect.stringMatching(/^#[0-9a-f]{6}$/), plural: expect.any(String) });
    expect(LANES_ALWAYS.every((l) => LANE_ORDER.includes(l))).toBe(true);
  });

  it("uses the spec's inks", () => {
    expect(LANE_META['payment']!.ink).toBe('#3550c8');
    expect(LANE_META['swap']!.ink).toBe('#7442d1');
    expect(LANE_META['signed_payment']!.ink).toBe('#2a7fa8');
    expect(LANE_META['issuance']!.ink).toBe('#c06a12');
  });

  it('falls back for a lane it does not know and for no lane', () => {
    expect(laneMeta('teleport')).toEqual({ label: 'teleport', ink: '#8b8f97', plural: 'teleport' });
    expect(laneMeta(null).label).toBe('—');
  });
});

describe('names', () => {
  it('names the PoolManager and the zero address, lowercase keys only', () => {
    expect(nameOf('0x8366A39CC670B4001A1121B8F6A443A643E40951')).toBe('Uniswap v4 Pools');
    expect(nameOf('0x0000000000000000000000000000000000000000')).toBe('Mint / burn');
    expect(nameOf('0x1111111111111111111111111111111111111111')).toBeUndefined();
    for (const k of Object.keys(NAMES)) expect(k).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
