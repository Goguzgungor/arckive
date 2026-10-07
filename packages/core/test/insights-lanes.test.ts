import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  AbiError, LANE_QUESTION, LANES, buildInsightsTables, extractFunctionNames, settleLane,
} from '../src/index.js';

describe('LANES', () => {
  it('keeps Radar’s order, which is part of the question', () => {
    expect(Object.keys(LANES)).toEqual([
      'swap', 'bridge', 'liquidity', 'vault', 'lending', 'signed_payment', 'payment', 'spam',
    ]);
    expect(LANE_QUESTION).toMatchObject({ type: 'choice', instructions: 'What kind of Arc transaction is this?' });
  });
});

describe('settleLane', () => {
  const answer = (choice: string, probabilities: Record<string, number>) => ({ choice, probabilities });

  it('a ruled lane stands, with no confidence', () => {
    expect(settleLane(null, 'issuance')).toEqual({ lane: 'issuance', laneP: null });
  });

  it('the model’s choice stands above the line', () => {
    expect(settleLane(answer('swap', { swap: 0.8312, bridge: 0.1 }), '')).toEqual({ lane: 'swap', laneP: 0.831 });
  });

  it('below the line it is uncertain, confidence kept', () => {
    expect(settleLane(answer('vault', { vault: 0.3 }), '')).toEqual({ lane: 'uncertain', laneP: 0.3 });
  });

  it('spam is overruled in favour of the runner-up', () => {
    expect(settleLane(answer('spam', { spam: 0.5, payment: 0.4, swap: 0.1 }), '')).toEqual({ lane: 'payment', laneP: 0.4 });
    expect(settleLane(answer('spam', { spam: 0.9 }), '')).toEqual({ lane: 'uncertain', laneP: 0 });
  });

  it('a lane outside the set is uncertain', () => {
    expect(settleLane(answer('issuance', { issuance: 0.9 }), '').lane).toBe('uncertain');
  });

  it('no answer is uncertain', () => {
    expect(settleLane(null, '')).toEqual({ lane: 'uncertain', laneP: null });
  });
});

describe('buildInsightsTables', () => {
  it('creates _insights keyed like the event rows and a single-row cursor', () => {
    const sql = buildInsightsTables('idx_demo').join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "idx_demo"."_insights"');
    expect(sql).toContain('PRIMARY KEY (block_number, log_index)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "idx_demo"._labels');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "idx_demo"."_insights_cursor"');
    expect(sql).toContain('CHECK (id = 1)');
  });
});

describe('extractFunctionNames', () => {
  it('maps every function selector to its name', () => {
    const abi = [
      { type: 'function', name: 'depositFor', inputs: [{ name: 'a', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
      { type: 'event', name: 'Deposited', inputs: [] },
    ];
    expect([...extractFunctionNames(abi)]).toEqual([[toFunctionSelector('depositFor(address)'), 'depositFor']]);
  });

  it('refuses a non-array ABI', () => {
    expect(() => extractFunctionNames({})).toThrow(AbiError);
  });
});
