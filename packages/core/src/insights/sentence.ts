import type { AbiEvent } from 'viem';
import {
  FACT_BY_SELECTOR, FACT_PHRASE, factsOf, protocolOf, type Fact, type TxContext,
} from './signatures.js';

// Turns one indexed event and its transaction into the sentence the model
// reads (Radar's `shape`, radar/radar/summarize.py). Addresses never appear:
// which wallet sent a swap says nothing about it being a swap, and naming it
// would split one campaign into thousands of distinct sentences.

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// empty input, transfer, transferFrom
const PLAIN_SELECTORS: ReadonlySet<string> = new Set(['0x', '0xa9059cbb', '0x23b872dd']);

// Facts that describe who sent a transaction or what it cost, not what it did.
// A zero transfer with only these beside it still did nothing.
const INCIDENTAL: ReadonlySet<Fact> = new Set<Fact>(['smart_account', 'fee']);

export interface TokenInfo {
  label: string; // the token's symbol, or the contract's name when it has none
  decimals: number | null; // null when decimals() could not be read
}

export interface TransferFields {
  from: string; // lowercase
  to: string; // lowercase
  value: bigint; // raw units
}

// The indexed contract a transaction called, and the function, when its ABI
// names the selector.
export interface CallInfo {
  contract: string;
  fn: string | null;
}

export interface DescribeInput {
  contractName: string;
  contractAddress: string; // lowercase
  eventName: string;
  transfer: TransferFields | null; // set only for ERC-20-shaped Transfer events
  token: TokenInfo | null; // set only for ERC-20-shaped Transfer events
  ctx: TxContext | null; // null when the transaction could not be read
  parties: Readonly<Record<string, boolean>>; // address -> is a contract; may lack an address
  call: CallInfo | null;
}

export interface Description {
  sentence: string;
  facts: Fact[];
  protocol: string;
  ruled: string; // the lane the transaction itself decides, or '' for the model
}

// ERC-721's Transfer has the same topic0 as ERC-20's, with the token id
// indexed; read as an amount it would call every NFT move a fortune.
export function isTransferEvent(def: { event: AbiEvent; topic0: string }): boolean {
  const [from, to, value] = def.event.inputs;
  return (
    def.topic0 === TRANSFER_TOPIC &&
    def.event.inputs.length === 3 &&
    from?.type === 'address' &&
    to?.type === 'address' &&
    value?.type === 'uint256' &&
    value.indexed !== true
  );
}

// Amounts are bucketed, not dropped: a near-zero value is the signature of
// dust spam. With label USDC and 6 decimals these are Radar's buckets.
export function amountBucket(value: bigint, token: TokenInfo): string {
  const t = token.label;
  if (value === 0n) return `zero ${t}`;
  if (token.decimals === null) return `a nonzero amount of ${t}`;
  const unit = 10n ** BigInt(token.decimals);
  if (value * 100n < unit) return `less than one cent of ${t}`;
  if (value < unit) return `under 1 ${t}`;
  if (value < 100n * unit) return `1 to 100 ${t}`;
  if (value < 10_000n * unit) return `100 to 10,000 ${t}`;
  return `over 10,000 ${t}`;
}

function party(address: string, parties: Readonly<Record<string, boolean>>): string {
  if (!Object.hasOwn(parties, address)) return 'an account';
  return parties[address] ? 'a contract' : 'a wallet';
}

function head(input: DescribeInput): string {
  const { transfer: t, token } = input;
  if (!t || !token) return `The ${input.contractName} contract logged ${input.eventName}.`;
  const amount = amountBucket(t.value, token);
  if (t.from === ZERO_ADDRESS) return `${token.label} was minted to ${party(t.to, input.parties)}, amount ${amount}.`;
  if (t.to === ZERO_ADDRESS) return `${token.label} was burned from ${party(t.from, input.parties)}, amount ${amount}.`;
  return `${token.label} moved from ${party(t.from, input.parties)} to ${party(t.to, input.parties)}, amount ${amount}.`;
}

// Radar's _plain, with "called USDC" generalised to "called this contract".
function isPlain(ctx: TxContext | null, facts: Fact[], contractAddress: string): boolean {
  return (
    ctx !== null &&
    facts.length === 0 &&
    PLAIN_SELECTORS.has(ctx.selector) &&
    (ctx.to === contractAddress || ctx.selector === '0x')
  );
}

// The ABI's name for the function called — what a custom contract has instead
// of a row in the fact table. Left out where Radar's sentence already says
// what happened, so known-protocol sentences stay Radar's byte for byte.
function callPhrase(ctx: TxContext | null, call: CallInfo | null): string {
  if (!ctx || !call?.fn) return '';
  if (FACT_BY_SELECTOR.has(ctx.selector) || PLAIN_SELECTORS.has(ctx.selector)) return '';
  return `It was called with ${call.fn}.`;
}

function tail(ctx: TxContext | null, facts: Fact[], plain: boolean): string {
  if (!ctx) return 'The rest of the transaction could not be read.';
  const phrases = facts.map((f) => FACT_PHRASE[f]);
  if (!phrases.length) phrases.push(plain ? 'it was a plain direct transfer' : 'nothing else recognisable happened');
  return `In the same transaction: ${phrases.join('; ')}.`;
}

// Radar's ruled_lane, generalised. Mint and burn are not a judgement; a zero
// transfer with nothing else happening is spam; and where nothing is
// recognisable the model answered arbitrarily ("vault" at 0.82, "lending" at
// 0.64, depending only on wording), so those rows are uncertain. Other events
// carry their own name for the model to read, so only an unreadable
// transaction rules them.
function ruledLane(input: DescribeInput, facts: Fact[], plain: boolean, called: string): string {
  const { ctx, transfer: t } = input;
  if (!ctx) return 'uncertain';
  if (!t || !input.token) return '';
  if ((t.from === ZERO_ADDRESS || t.to === ZERO_ADDRESS) && !facts.includes('bridge')) return 'issuance';
  if (t.value === 0n && facts.every((f) => INCIDENTAL.has(f))) return 'spam';
  if (!facts.length && !plain && !called) return 'uncertain';
  return '';
}

export function describeEvent(input: DescribeInput): Description {
  const { ctx } = input;
  const facts = factsOf(ctx);
  const plain = isPlain(ctx, facts, input.contractAddress);
  const called = callPhrase(ctx, input.call);
  return {
    sentence: [head(input), called, tail(ctx, facts, plain)].filter(Boolean).join(' '),
    facts,
    protocol: protocolOf(ctx) || input.call?.contract || '',
    ruled: ruledLane(input, facts, plain, called),
  };
}
