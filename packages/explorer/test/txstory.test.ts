import { describe, expect, it } from 'vitest';
import * as R from './fixture/rows.ts';
import type { TxData } from '../lib/tx.js';
import {
  eventRows, flowCaption, flowView, isChain, legsLabel, swapView, tokenAddresses, txFacts, txHeadline, txPath,
} from '../lib/txstory.js';

const POOL = { id: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO };
const base = (over: Partial<TxData>): TxData => ({
  hash: R.SWAP_TX, block: 24787775, time: Date.UTC(2026, 9, 7, 20, 33, 32) / 1000,
  transfers: [], swaps: [], modifies: [], donates: [], inits: [], pools: {}, ...over,
});
const SWAP: TxData = base({
  transfers: [
    { li: 1, from: R.SWAP_PAYER, to: R.SWAP_HOP, value: R.SWAP_PAID },
    { li: 2, from: R.SWAP_HOP, to: R.ROUTER, value: R.SWAP_PAID },
    { li: 4, from: R.ROUTER, to: R.POOLMANAGER, value: R.SWAP_PAID },
  ],
  swaps: [{ li: 3, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: `-${R.SWAP_PAID}`, amount1: R.SWAP_RECEIVED, fee: 2500 }],
  pools: { [R.SWAP_POOL]: POOL },
});
const TOKENS = { [R.SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } };
const t = (li: number, from: string, to: string, whole: number) => ({ li, from, to, value: R.usdc(whole) });

describe('the known mainnet swap', () => {
  it('reads negative deltas as paid into the pool (mainnet tx 0x9a83…015a)', () => {
    expect(swapView(SWAP.swaps[0]!, POOL, TOKENS)).toEqual({
      li: 3, pool: R.SWAP_POOL, fee: '0.25%', known: true,
      paid: { amount: '476.93', token: 'USDC (native)', tokenAddress: R.ZERO, decimals: true, note: 'USDC (native)' },
      received: { amount: '13,763,833.33', token: 'PUMP', tokenAddress: R.SWAP_TOKEN, decimals: true, note: 'PUMP' },
    });
  });

  it('writes its headline and path', () => {
    expect(txHeadline(SWAP)).toEqual([{ addr: R.SWAP_PAYER }, ' swapped ', { b: '476.93 USDC' }, ' on Uniswap v4.']);
    expect(txPath(SWAP, TOKENS)).toEqual([
      'The USDC went from ', { addr: R.SWAP_PAYER }, ' through ', { addr: R.SWAP_HOP }, ' and ', { addr: R.ROUTER },
      ' to ', { addr: R.POOLMANAGER }, ' in block ', { b: '24,787,775' }, ' at 20:33:32 UTC.',
      ' It came back as ', { b: '13,763,833.33' }, ' of PUMP.',
    ]);
  });

  it('lists events in log order and states the facts', () => {
    expect(eventRows(SWAP).map((e) => [e.li, e.kind, e.amount])).toEqual([
      [1, 'Transfer', '476.93 USDC'], [2, 'Transfer', '476.93 USDC'], [3, 'Swap', null], [4, 'Transfer', '476.93 USDC'],
    ]);
    expect(eventRows(SWAP)[2]!.parts).toEqual(['pool ', '0x6c96ee62…dd79e8', ' · sender ', { addr: R.ROUTER }]);
    expect(txFacts(SWAP)).toEqual({ protocol: 'Uniswap v4', pool: R.SWAP_POOL, parties: [R.SWAP_PAYER, R.SWAP_HOP, R.ROUTER, R.POOLMANAGER] });
    expect(legsLabel(SWAP)).toBe('3 USDC movements · 1 swap');
    expect(tokenAddresses(SWAP)).toEqual([R.ZERO, R.SWAP_TOKEN]);
  });

  it('draws the chain as nodes and edges', () => {
    expect(flowView(SWAP.transfers)).toEqual({
      nodes: [
        { role: 'Payer', address: R.SWAP_PAYER }, { role: 'Through', address: R.SWAP_HOP },
        { role: 'Through', address: R.ROUTER }, { role: 'Arrived at', address: R.POOLMANAGER },
      ],
      edges: [{ amount: '476.93', li: 1 }, { amount: '476.93', li: 2 }, { amount: '476.93', li: 4 }],
    });
  });
});

describe('other swaps', () => {
  it('writes "swapped for" when USDC came out of the pool', () => {
    const tx = base({
      transfers: [t(5, R.POOLMANAGER, R.SWAP_PAYER, 10)],
      swaps: [{ li: 4, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: R.usdc(10), amount1: `-${R.SWAP_RECEIVED}`, fee: 2500 }],
      pools: { [R.SWAP_POOL]: POOL },
    });
    expect(txHeadline(tx)).toEqual([{ addr: R.SWAP_PAYER }, ' swapped for ', { b: '10.00 USDC' }, ' on Uniswap v4.']);
    expect(txPath(tx, TOKENS).slice(-3)).toEqual([' It was paid for with ', { b: '13,763,833.33' }, ' of PUMP.']);
  });

  it('knows the ERC-20 face of USDC (0x3600…0000, 6 decimals) in a pool as the USDC side', () => {
    const erc20 = '0x3600000000000000000000000000000000000000';
    const pool = { ...POOL, currency0: erc20 };
    const tx = base({
      transfers: [t(1, R.SWAP_PAYER, R.POOLMANAGER, 1)],
      swaps: [{ li: 3, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: '-998', amount1: R.SWAP_RECEIVED, fee: 2500 }],
      pools: { [R.SWAP_POOL]: pool },
    });
    expect(txHeadline(tx)).toEqual([{ addr: R.SWAP_PAYER }, ' swapped ', { b: '<0.01 USDC' }, ' on Uniswap v4.']);
    const big = { ...tx, swaps: [{ ...tx.swaps[0]!, amount0: '-12340000' }] };
    expect(txHeadline(big)[2]).toEqual({ b: '12.34 USDC' });
    const v = swapView(tx.swaps[0]!, pool, { [erc20]: { symbol: 'USDC', decimals: 6 }, ...TOKENS });
    expect(v.paid).toMatchObject({ token: 'USDC', amount: '<0.01', decimals: true, note: 'USDC' });
    // the native face is labelled as such
    expect(swapView(SWAP.swaps[0]!, POOL, TOKENS).paid?.token).toBe('USDC (native)');
    // "came back as" is about the other side only
    expect(txPath(tx, { [erc20]: { symbol: 'USDC', decimals: 6 }, ...TOKENS }).slice(-3)).toEqual([' It came back as ', { b: '13,763,833.33' }, ' of PUMP.']);
    const rev = base({
      swaps: [{ li: 3, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: '5000000', amount1: '-7', fee: 2500 }],
      pools: { [R.SWAP_POOL]: pool },
    });
    expect(txPath(rev, TOKENS).join('')).not.toMatch(/USDC/);
  });

  it('falls back when the pool is unknown or the token has no decimals', () => {
    const tx = base({ swaps: SWAP.swaps });
    expect(txHeadline(tx)).toEqual(['A swap on Uniswap v4.']);
    expect(swapView(SWAP.swaps[0]!, undefined, {})).toMatchObject({ known: false, paid: null, received: null });
    // the raw integer, grouped; what is unknown goes on the line under it
    const unknown = { [R.SWAP_TOKEN]: { symbol: null, decimals: null } };
    expect(swapView(SWAP.swaps[0]!, POOL, unknown).received).toEqual({
      amount: '13,763,833,330,793,760,056,038,261', token: '0x6e71…b777', tokenAddress: R.SWAP_TOKEN,
      decimals: false, note: 'token 0x6e71…b777 · decimals unknown',
    });
    expect(txPath(SWAP, unknown).slice(-3)).toEqual([' It came back as ', { b: '13,763,833,330,793,760,056,038,261' }, ' (raw units) of 0x6e71…b777.']);
    // a symbol without decimals
    expect(swapView(SWAP.swaps[0]!, POOL, { [R.SWAP_TOKEN]: { symbol: 'PUMP', decimals: null } }).received?.note).toBe('PUMP · decimals unknown');
  });
});

describe('transfers without a swap', () => {
  it('writes a payment', () => {
    const tx = base({ transfers: [{ li: 0, from: R.PAYER, to: R.PAYEE, value: R.usdc(311, 55) }] });
    expect(txHeadline(tx)).toEqual([{ addr: R.PAYER }, ' paid ', { addr: R.PAYEE }, ' ', { b: '311.55 USDC' }, '.']);
    expect(txPath(tx, {})).toEqual(['In block ', { b: '24,787,775' }, ' at 20:33:32 UTC.']);
    expect(legsLabel(tx)).toBe('1 USDC movement');
  });

  it('writes a chain from its first payer to its last payee', () => {
    const tx = base({ transfers: [t(0, R.CHAIN[0]!, R.CHAIN[1]!, 50), t(1, R.CHAIN[1]!, R.CHAIN[2]!, 50), t(2, R.CHAIN[2]!, R.CHAIN[3]!, 50)] });
    expect(isChain(tx.transfers)).toBe(true);
    expect(txHeadline(tx)).toEqual([{ addr: R.CHAIN[0] }, ' paid ', { addr: R.CHAIN[3] }, ' ', { b: '50.00 USDC' }, '.']);
  });

  it('writes mints, burns and self-transfers', () => {
    expect(txHeadline(base({ transfers: [t(0, R.ZERO, R.MINTEE, 10000)] }))).toEqual([{ b: '10,000.00 USDC' }, ' were minted to ', { addr: R.MINTEE }, '.']);
    expect(txHeadline(base({ transfers: [t(0, R.MINTEE, R.ZERO, 5)] }))).toEqual([{ b: '5.00 USDC' }, ' were burned from ', { addr: R.MINTEE }, '.']);
    expect(txHeadline(base({ transfers: [t(0, R.SELF, R.SELF, 1)] }))).toEqual([{ addr: R.SELF }, ' sent ', { b: '1.00 USDC' }, ' to itself.']);
  });

  it('sums movements that do not form a chain, and draws no flow for them', () => {
    const tx = base({ transfers: [t(0, R.PAYER, R.PAYEE, 1), t(1, R.CHAIN[0]!, R.CHAIN[1]!, 2)] });
    expect(txHeadline(tx)).toEqual([{ b: '2' }, ' USDC movements in this transaction, ', { b: '3.00 USDC' }, ' in all.']);
    expect(flowView(tx.transfers)).toBeNull();
  });

  it('captions the flow, or the list below when there is no flow to draw', () => {
    expect(flowCaption(true)).toMatch(/^Fig\. 1 — every USDC movement in this transaction, in log order\./);
    expect(flowCaption(false)).toMatch(/^Fig\. 1 — the USDC movements are listed under Events, in log order;/);
    for (const drawn of [true, false]) expect(flowCaption(drawn)).toContain('gas and other tokens are not shown');
  });

  it('draws no flow for a chain longer than six', () => {
    const hops = Array.from({ length: 7 }, (_, i) => t(i, `0x${String(i).repeat(40)}`, `0x${String(i + 1).repeat(40)}`, 1));
    expect(isChain(hops)).toBe(true);
    expect(flowView(hops)).toBeNull();
  });
});

describe('pool events without USDC', () => {
  it('names what happened to the pool', () => {
    const init = { li: 3, pool: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO };
    expect(txHeadline(base({ inits: [init] }))).toEqual(['A Uniswap v4 pool was created.']);
    const modify = { li: 0, pool: R.SWAP_POOL, sender: R.LP, tickLower: -600, tickUpper: 600, liquidityDelta: '-5' };
    expect(txHeadline(base({ modifies: [modify] }))).toEqual(['Liquidity changed in a Uniswap v4 pool.']);
    expect(eventRows(base({ modifies: [modify] }))[0]!.parts).toEqual(['pool ', '0x6c96ee62…dd79e8', ' · removed by ', { addr: R.LP }]);
    const donate = { li: 1, pool: R.SWAP_POOL, sender: R.LP, amount0: '1', amount1: '0' };
    expect(txHeadline(base({ donates: [donate] }))).toEqual(['A donation to a Uniswap v4 pool.']);
    expect(eventRows(base({ inits: [init] }))[0]!.parts).toEqual(['pool ', '0x6c96ee62…dd79e8', ' created · fee ', '0.25%']);
  });
});
