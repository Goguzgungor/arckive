import type { AbiEvent } from 'viem';
import { toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  amountBucket, describeEvent, factsOf, isTransferEvent, protocolOf,
  TRANSFER_TOPIC, ZERO_ADDRESS, type DescribeInput, type TxContext,
} from '../src/index.js';

const TOKEN = '0x' + '11'.repeat(20);
const VAULT = '0x' + '22'.repeat(20);
const WALLET = '0x' + 'a1'.repeat(20);
const WALLET2 = '0x' + 'a2'.repeat(20);
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const OKX_COMMISSION = '0x7970b0744fdb6cf0b120e5e0a5f4da3ab8cbec6d5d9ec8a4f327ccc1d8a5eb8b';
const AERO_FACTORY = '0xb89df768af2cfe637ceb352c587fe8edaf491d03';
const POOL = '0x' + '90'.repeat(20);

const ctx = (over: Partial<TxContext> = {}): TxContext => ({
  to: VAULT, selector: '0x12345678', topics: [], sender: WALLET, emitters: [], factories: {}, ...over,
});

const erc20Transfer: AbiEvent = {
  type: 'event', name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
};
const erc721Transfer: AbiEvent = {
  type: 'event', name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ],
};

const custom = (over: Partial<DescribeInput> = {}): DescribeInput => ({
  contractName: 'vault', contractAddress: VAULT, eventName: 'Deposited',
  transfer: null, token: null, ctx: ctx(), parties: {}, call: null, ...over,
});

describe('isTransferEvent', () => {
  it('accepts ERC-20 Transfer and refuses ERC-721, which shares its topic', () => {
    expect(toEventSelector(erc721Transfer)).toBe(TRANSFER_TOPIC);
    expect(isTransferEvent({ event: erc20Transfer, topic0: TRANSFER_TOPIC })).toBe(true);
    expect(isTransferEvent({ event: erc721Transfer, topic0: TRANSFER_TOPIC })).toBe(false);
  });
});

describe('amountBucket', () => {
  it('buckets in the token’s own decimals', () => {
    const t = { label: 'WETH', decimals: 18 };
    expect(amountBucket(0n, t)).toBe('zero WETH');
    expect(amountBucket(10n ** 15n, t)).toBe('less than one cent of WETH');
    expect(amountBucket(10n ** 17n, t)).toBe('under 1 WETH');
    expect(amountBucket(5n * 10n ** 18n, t)).toBe('1 to 100 WETH');
    expect(amountBucket(10n ** 22n, t)).toBe('over 10,000 WETH');
  });

  it('says only zero or not when decimals are unknown', () => {
    expect(amountBucket(0n, { label: 'X', decimals: null })).toBe('zero X');
    expect(amountBucket(7n, { label: 'X', decimals: null })).toBe('a nonzero amount of X');
  });
});

describe('describeEvent — other events', () => {
  it('names the contract and the event, then the facts', () => {
    const d = describeEvent(custom({ ctx: ctx({ topics: [V3_SWAP] }) }));
    expect(d.sentence).toBe(
      'The vault contract logged Deposited. In the same transaction: tokens were swapped on an exchange.',
    );
    expect(d.facts).toEqual(['swap']);
    expect(d.ruled).toBe('');
  });

  it('adds the function called on an indexed contract', () => {
    const d = describeEvent(custom({ call: { contract: 'vault', fn: 'depositFor' } }));
    expect(d.sentence).toBe(
      'The vault contract logged Deposited. It was called with depositFor. ' +
        'In the same transaction: nothing else recognisable happened.',
    );
    expect(d.protocol).toBe('vault');
  });

  it('leaves the function out when the selector is already a fact or a plain transfer', () => {
    const known = describeEvent(custom({ ctx: ctx({ selector: '0x3593564c' }), call: { contract: 'vault', fn: 'execute' } }));
    expect(known.sentence).not.toContain('It was called with');
    const plain = describeEvent(custom({ ctx: ctx({ selector: '0xa9059cbb' }), call: { contract: 'vault', fn: 'transfer' } }));
    expect(plain.sentence).not.toContain('It was called with');
  });

  it('goes to the model unless the transaction could not be read', () => {
    expect(describeEvent(custom()).ruled).toBe('');
    const unread = describeEvent(custom({ ctx: null }));
    expect(unread.ruled).toBe('uncertain');
    expect(unread.sentence).toBe(
      'The vault contract logged Deposited. The rest of the transaction could not be read.',
    );
  });
});

describe('describeEvent — transfers of any token', () => {
  const transfer = (over: Partial<DescribeInput> = {}): DescribeInput => ({
    contractName: 'weth', contractAddress: TOKEN, eventName: 'Transfer',
    transfer: { from: WALLET, to: WALLET2, value: 5n * 10n ** 18n },
    token: { label: 'WETH', decimals: 18 },
    ctx: ctx({ to: TOKEN, selector: '0xa9059cbb' }),
    parties: { [WALLET]: false, [WALLET2]: false },
    call: { contract: 'weth', fn: 'transfer' },
    ...over,
  });

  it('reads like Radar with the token’s own label', () => {
    expect(describeEvent(transfer()).sentence).toBe(
      'WETH moved from a wallet to a wallet, amount 1 to 100 WETH. ' +
        'In the same transaction: it was a plain direct transfer.',
    );
  });

  it('rules mint, burn and zero transfers the way Radar does', () => {
    expect(describeEvent(transfer({ transfer: { from: ZERO_ADDRESS, to: WALLET, value: 1n } })).ruled).toBe('issuance');
    expect(describeEvent(transfer({ transfer: { from: WALLET, to: ZERO_ADDRESS, value: 1n } })).ruled).toBe('issuance');
    expect(describeEvent(transfer({ transfer: { from: WALLET, to: WALLET2, value: 0n } })).ruled).toBe('spam');
  });

  it('asks the model about an unknown call when the ABI names it', () => {
    const named = describeEvent(transfer({ ctx: ctx({ to: VAULT, selector: '0x12345678' }), call: { contract: 'vault', fn: 'depositFor' } }));
    expect(named.ruled).toBe('');
    const unnamed = describeEvent(transfer({ ctx: ctx({ to: VAULT, selector: '0x12345678' }), call: null }));
    expect(unnamed.ruled).toBe('uncertain');
  });
});

describe('facts and protocols', () => {
  it('reads facts in a fixed order', () => {
    expect(factsOf(ctx({ selector: '0x', topics: [OKX_COMMISSION, V3_SWAP] }))).toEqual(['swap', 'fee']);
    expect(factsOf(null)).toEqual([]);
  });

  it('names the exchange by the pool, not by the event', () => {
    const unknown = ctx({ topics: [V3_SWAP], emitters: [POOL] });
    expect(protocolOf(unknown)).toBe('');
    expect(protocolOf({ ...unknown, factories: { [POOL]: AERO_FACTORY } })).toBe('Aerodrome');
  });
});
