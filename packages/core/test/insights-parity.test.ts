import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeEvent, type TxContext } from '../src/index.js';

// Cases written by radar/scripts/export_parity.py from Radar's own summarize():
// every distinct lane sentence in 1,200 live mainnet transfers, plus hand-made
// mints, burns, zero transfers and unreadable transactions.
interface ParityCase {
  transfer: { frm: string; to: string; value: string };
  ctx: TxContext | null;
  contracts: Record<string, boolean>;
  expected: { shape: string; ruled: string; facts: string[]; protocol: string };
}

const USDC = '0x3600000000000000000000000000000000000000';
const cases = JSON.parse(
  readFileSync(new URL('./fixtures/radar-parity.json', import.meta.url), 'utf8'),
) as ParityCase[];

describe('Radar parity', () => {
  it('the fixture covers the capture', () => {
    expect(cases.length).toBeGreaterThanOrEqual(140);
  });

  it.each(cases.map((c, i) => [i, c] as const))('case %i matches Radar', (_i, c) => {
    const d = describeEvent({
      contractName: 'usdc',
      contractAddress: USDC,
      eventName: 'Transfer',
      transfer: { from: c.transfer.frm, to: c.transfer.to, value: BigInt(c.transfer.value) },
      token: { label: 'USDC', decimals: 6 },
      ctx: c.ctx,
      parties: c.contracts,
      // Radar has no ABI names, so no function name is ever offered here.
      call: c.ctx?.to === USDC ? { contract: 'USDC', fn: null } : null,
    });
    expect(d.sentence).toBe(c.expected.shape);
    expect(d.ruled).toBe(c.expected.ruled);
    expect(d.facts).toEqual(c.expected.facts);
    // Radar also calls a native value send "USDC"; the worker names a contract
    // only when that contract was the one called.
    if (!(c.expected.protocol === 'USDC' && c.ctx?.to !== USDC)) {
      expect(d.protocol).toBe(c.expected.protocol);
    }
  });
});
