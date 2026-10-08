import { readFileSync } from 'node:fs';
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
    for (const lane of LANE_ORDER) expect(LANE_META[lane], lane).toMatchObject({ label: expect.any(String), ink: expect.stringMatching(/^var\(--(l-[a-z_]+|faint)\)$/), plural: expect.any(String) });
    expect(LANES_ALWAYS.every((l) => LANE_ORDER.includes(l))).toBe(true);
  });

  // The inks are custom properties in app/globals.css: the day edition uses
  // the spec's, and each theme (system night and picked night) sets every one.
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const block = (selector: string): string => css.slice(css.indexOf(selector)).split('}')[0]!;
  const inks = [...new Set(Object.values(LANE_META).map((m) => m.ink.match(/--l-[a-z_]+/)?.[0]).filter((v) => v !== undefined))];

  it("uses the spec's inks in the day edition", () => {
    const day = block(':root {');
    expect(day).toContain('--l-payment: #3550c8;');
    expect(day).toContain('--l-swap: #7442d1;');
    expect(day).toContain('--l-signed_payment: #2a7fa8;');
    expect(day).toContain('--l-issuance: #c06a12;');
  });

  it('sets every lane ink in each edition', () => {
    expect(inks.length).toBe(8);
    for (const sel of [':root {', ":root:not([data-theme='light']) {", ":root[data-theme='dark'] {"]) {
      for (const ink of inks) expect(block(sel), `${sel} ${ink}`).toMatch(new RegExp(`${ink}: #[0-9a-f]{6};`));
    }
  });

  it('falls back for a lane it does not know and for no lane', () => {
    expect(laneMeta('teleport')).toEqual({ label: 'teleport', ink: 'var(--faint)', plural: 'teleport' });
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
