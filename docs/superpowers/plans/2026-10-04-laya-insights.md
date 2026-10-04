# Laya Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `Indexer` with `spec.insights.laya.{url, headerSecretRef}` gets every indexed event classified into a transaction lane by a Laya model gate, written to `_insights` in near real time, without ever slowing or blocking ingest.

**Architecture:** Pure sentence/lane logic ported from `radar/` lives in `@arckive/core/src/insights/` and is proven byte-identical to Radar on a captured mainnet sample. The worker runs a second loop behind the ingest cursor: it reads committed event rows, fetches tx context over RPC, asks the gate for the unruled sentences, and writes `_insights` + `_insights_cursor` in one transaction. Ingest gets a single optional `onCommitted` hook and nothing else.

**Tech Stack:** TypeScript ESM (NodeNext, strict, verbatimModuleSyntax), zod, viem, pg, prom-client, vitest, testcontainers, anvil/forge; Python 3.12 for the parity generator.

**Spec:** `docs/superpowers/specs/2026-10-04-laya-insights-design.md`

## Global Constraints

- Lane set, order and wording are Radar's verbatim: `swap, bridge, liquidity, vault, lending, signed_payment, payment, spam`; question `"What kind of Arc transaction is this?"`.
- `UNCERTAIN_BELOW = 0.35`; at most 64 states per gate call; at most 60 gate calls a minute; 30 s per call; 60,000-sentence cache.
- The header value comes only from env `INSIGHTS_HEADER` (Secret via `secretKeyRef`); it never appears in `config.json`, logs or error messages.
- Insight failures never call `PhaseTracker`; `/healthz` and CR phase describe ingest only.
- `_insights` writes and the `_insights_cursor` update happen in one transaction; `ON CONFLICT DO NOTHING`.
- The insights cursor never passes `_cursor`.
- Env vars read with bracket notation; relative imports carry `.js`; type-only imports use `import type`.
- Without `spec.insights` the rendered worker config, its hash, the Deployment and the DB schema are byte-identical to today.
- Commit messages: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `packages/worker/src/ws.ts` (unrelated local change).

## Review Focus

1. ERC-721 `Transfer` has the same topic0 as ERC-20's but indexes `tokenId` — it must not be read as an amount (Task 2 test).
2. A token's `symbol()` is chain-controlled text that lands in the model's sentence — strip it to a short ticker or fall back to the contract name (Task 6 test).
3. The gate is down (refused, 5xx, timeout, 401) — the round writes nothing, the insights cursor stays, the error is counted by stage, and the loop keeps retrying (Task 7 tests).
4. Insights enabled on an indexer that never had them — tables are created, ingest config hash is unchanged for indexers without insights (Task 4 test).
5. A header line that is malformed or contains the secret in a bad name — startup fails with a message that does not echo the value (Task 5 test).

---

### Task 1: Radar parity fixture

**Files:**
- Create: `radar/scripts/export_parity.py`
- Create: `packages/core/test/fixtures/radar-parity.json` (generated)

**Interfaces:**
- Produces: JSON array of `{ transfer: { frm, to, value: string }, ctx: TxContext | null, contracts: Record<string, boolean>, expected: { shape, ruled, facts, protocol } }`, consumed by Task 2's parity test.

- [ ] **Step 1: Write the generator**

```python
"""Write what Radar says about each transfer, for the worker's port to match.

The worker rebuilds Radar's lane sentence in TypeScript
(packages/core/src/insights). Radar's measured accuracy carries over only if
the model reads the same text, so the port is tested against what this
module actually produces: one case per distinct sentence in the live capture,
plus the hand-made cases the capture does not contain (mint, burn, zero
transfers, unreadable transactions, unknown parties).

    cd radar && .venv/bin/python scripts/export_parity.py \
        > ../packages/core/test/fixtures/radar-parity.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from radar.summarize import summarize  # noqa: E402
from radar.types import USDC, ZERO  # noqa: E402

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
USER_OP = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"
WALLET = "0x" + "a1" * 20
WALLET2 = "0x" + "a2" * 20
POOL = "0x" + "b1" * 20
ROUTER = "0x" + "c1" * 20


def ctx(selector: str, to: str | None, topics: list[str]) -> dict:
    return {"to": to, "selector": selector, "topics": topics, "sender": WALLET,
            "emitters": [USDC] * len(topics), "factories": {}}


def item(frm=WALLET, to=WALLET2, value=12_000_000, context=None, contracts=None) -> dict:
    return {
        "transfer": {"tx": "0x" + "00" * 32, "log_index": 0, "block": 1, "frm": frm, "to": to, "value": value},
        "ctx": context,
        "contracts": {WALLET: False, WALLET2: False, POOL: True, ROUTER: True} if contracts is None else contracts,
        "seen_at": 0.0,
    }


HAND_MADE = [
    item(frm=ZERO, to=WALLET, context=ctx("0x", None, [TRANSFER])),                    # mint
    item(frm=POOL, to=ZERO, context=ctx("0xdeadbeef", POOL, [TRANSFER])),              # burn
    item(frm=ZERO, to=WALLET, context=ctx("0x57ecfd28", ROUTER, [TRANSFER])),          # bridge mint
    item(value=0, context=ctx("0xa9059cbb", USDC, [TRANSFER])),                        # zero, plain
    item(value=0, context=ctx("0x765e827f", ROUTER, [USER_OP])),                       # zero, smart account
    item(value=4_000, context=ctx("0x", WALLET2, [TRANSFER])),                         # sub-cent native send
    item(value=9_999, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=10_000, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=999_999, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=100_000_000, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=10_000_000_000, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(context=ctx("0xdeadbeef", POOL, [TRANSFER, "0x" + "12" * 32])),               # unknown contract
    item(context=None),                                                                # unreadable
    item(context=ctx("0xa9059cbb", USDC, [TRANSFER]), contracts={}),                   # unknown parties
]


def case(it: dict) -> dict:
    s = summarize(it)
    return {
        "transfer": {"frm": it["transfer"]["frm"], "to": it["transfer"]["to"], "value": str(it["transfer"]["value"])},
        "ctx": it["ctx"],
        "contracts": it["contracts"],
        "expected": {"shape": s["shape"], "ruled": s["ruled"], "facts": s["facts"], "protocol": s["protocol"]},
    }


def main() -> None:
    capture = json.loads((ROOT / "tests/fixtures/live_sample.json").read_text())
    cases, seen = [], set()
    live = []
    for it in capture["items"]:
        c = capture["txs"].get(it["transfer"]["tx"])
        if c is not None:
            c = {**c, "emitters": c.get("emitters", []), "factories": c.get("factories", {})}
        live.append({**it, "ctx": c})
    for it in live + HAND_MADE:
        out = case(it)
        key = json.dumps(out["expected"], sort_keys=True)
        if key not in seen:
            seen.add(key)
            cases.append(out)
    json.dump(cases, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Generate the fixture**

Run: `cd radar && .venv/bin/python scripts/export_parity.py > ../packages/core/test/fixtures/radar-parity.json && python3 -c "import json;print(len(json.load(open('../packages/core/test/fixtures/radar-parity.json'))))"`
Expected: a count above 140 (133 distinct live sentences plus the hand-made ones).

- [ ] **Step 3: Commit**

```bash
git add radar/scripts/export_parity.py packages/core/test/fixtures/radar-parity.json
git commit -m "test(core): Radar parity fixture for the insights port"
```

---

### Task 2: Facts and sentences in core

**Files:**
- Create: `packages/core/src/insights/signatures.ts`
- Create: `packages/core/src/insights/sentence.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/insights-parity.test.ts`, `packages/core/test/insights-sentence.test.ts`

**Interfaces:**
- Produces:
  - `type Fact`, `FACT_ORDER: readonly Fact[]`, `FACT_PHRASE: Readonly<Record<Fact,string>>`, `FACT_BY_SELECTOR: ReadonlyMap<string,Fact>`, `FACT_BY_TOPIC: ReadonlyMap<string,Fact>`, `POOL_TOPICS: ReadonlySet<string>`, `FACTORY_CALL = '0xc45a0155'`
  - `interface TxContext { to: string|null; selector: string; topics: string[]; sender: string; emitters: string[]; factories: Record<string,string> }`
  - `factsOf(ctx: TxContext|null): Fact[]`, `protocolOf(ctx: TxContext|null): string`
  - `TRANSFER_TOPIC`, `ZERO_ADDRESS`, `interface TokenInfo { label: string; decimals: number|null }`, `interface TransferFields { from: string; to: string; value: bigint }`, `interface CallInfo { contract: string; fn: string|null }`, `interface DescribeInput {...}`, `interface Description { sentence; facts: Fact[]; protocol; ruled }`
  - `isTransferEvent(def: { event: AbiEvent; topic0: string }): boolean`, `amountBucket(value: bigint, token: TokenInfo): string`, `describeEvent(input: DescribeInput): Description`

- [ ] **Step 1: Write the failing parity test** — `packages/core/test/insights-parity.test.ts`

```ts
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
    expect(cases.length).toBeGreaterThan(140);
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
```

- [ ] **Step 2: Write the failing unit tests** — `packages/core/test/insights-sentence.test.ts`

```ts
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
    expect(amountBucket(10n ** 15n, t)).toBe('under 1 WETH');
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
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm --filter @arckive/core test -- insights`
Expected: FAIL — `describeEvent` is not exported.

- [ ] **Step 4: Write `packages/core/src/insights/signatures.ts`**

Port `radar/radar/signatures.py` verbatim: every selector and topic with its trailing comment, the module docstring as a header comment, the `FundsMovement` and WETH-wrap comments. Structure:

```ts
// What a transaction's selectors and events say, in words the model can use.
// Ported from radar/radar/signatures.py — keep the two in step; the parity
// fixture (core/test/fixtures/radar-parity.json) fails when they drift.
// <docstring paragraphs from signatures.py, as comments>

export type Fact =
  | 'bridge' | 'liquidity' | 'lending' | 'vault' | 'swap' | 'market'
  | 'batch' | 'payout' | 'wrap' | 'signed' | 'smart_account' | 'fee';

// The order the facts are read out in. Bridge comes before swap: a transfer
// that swaps and then leaves for another chain is a bridge transfer, and the
// lane descriptions say so in the same order.
export const FACT_ORDER: readonly Fact[] = [
  'bridge', 'liquidity', 'lending', 'vault', 'swap', 'market', 'batch', 'payout',
  'wrap', 'signed', 'smart_account', 'fee',
];

// The words the lane question reads.
export const FACT_PHRASE: Readonly<Record<Fact, string>> = {
  swap: 'tokens were swapped on an exchange',
  bridge: 'funds were sent across chains through a bridge',
  liquidity: 'pool liquidity changed',
  lending: 'a loan was opened, repaid or liquidated',
  vault: 'funds were deposited into or withdrawn from a vault',
  wrap: 'USDC was wrapped or unwrapped',
  market: 'tokens were bought or sold on a marketplace',
  batch: 'a batch of payments was sent to many recipients',
  payout: 'rewards or payouts were claimed or distributed',
  signed: 'the payer signed an authorization and someone else submitted it',
  smart_account: 'it was sent by a smart account',
  fee: 'a fee was taken',
};

export const FACT_BY_SELECTOR: ReadonlyMap<string, Fact> = new Map<string, Fact>([
  // swap
  ['0x3593564c', 'swap'], // execute(bytes,bytes[],uint256) — Uniswap Universal Router
  // ... every entry of FACT_BY_SELECTOR in signatures.py, same order, same comments
]);

export const FACT_BY_TOPIC: ReadonlyMap<string, Fact> = new Map<string, Fact>([
  // ... every entry of FACT_BY_TOPIC in signatures.py, same order, same comments
]);

export const POOL_TOPICS: ReadonlySet<string> = new Set([ /* the five POOL_TOPICS */ ]);

// factory() — the one view every Uniswap-v2 and -v3 style pool has.
export const FACTORY_CALL = '0xc45a0155';

const UNISWAP_V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const UNISWAP_ENTRY_POINTS: ReadonlySet<string> = new Set([
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1', // Universal Router
  '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b', // v4 PositionManager
]);
const FACTORY_NAMES: ReadonlyMap<string, string> = new Map([
  ['0xf0db7b58379503491d857db50ac9ece64c653918', 'Uniswap'], // UniswapV3Factory bytecode
  ['0xb89df768af2cfe637ceb352c587fe8edaf491d03', 'Aerodrome'], // Aero Lite CL factory
]);

// First match wins, most specific first (see signatures.py _PROTOCOL_RULES).
const PROTOCOL_RULES: ReadonlyArray<readonly [string, ReadonlySet<string>, ReadonlySet<string>]> = [
  ['CCTP', new Set(['0x8e0250ee', '0x779b432d', '0x57ecfd28']), new Set([/* 4 CCTP topics */])],
  ['Relay', new Set(), new Set(['0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1'])],
  ['LI.FI', new Set(), new Set([/* 3 LI.FI topics */])],
  ['OKX DEX', new Set(['0x0c307f76', '0x0d5f0e3b', '0xf2c42696', '0x44014e98']),
    new Set(['0x1bb43f2da90e35f7b0cf38521ca95a49e68eb42fac49924930a5bd73cdf7576c'])],
  ['KyberSwap', new Set(['0xe21fd0e9']), new Set()],
  ['1inch', new Set(['0x07ed2379']), new Set()],
  ['0x', new Set(['0x2213bc0b']), new Set()],
];

// One transaction as the facts are read from it (radar/radar/types.py).
export interface TxContext {
  to: string | null; // tx.to, lowercase; null for contract creation
  selector: string; // first 4 bytes of input, "0x" + 8 hex; "0x" when input is empty
  topics: string[]; // topic0 of every log in the receipt, lowercase, in log order
  sender: string; // tx.from, lowercase
  emitters: string[]; // the address that emitted each of `topics`, same order
  factories: Record<string, string>; // pool address -> the factory that deployed it
}

export function factsOf(ctx: TxContext | null): Fact[] {
  if (!ctx) return [];
  const found = new Set<Fact>();
  const bySelector = FACT_BY_SELECTOR.get(ctx.selector);
  if (bySelector) found.add(bySelector);
  for (const topic of ctx.topics) {
    const fact = FACT_BY_TOPIC.get(topic);
    if (fact) found.add(fact);
  }
  return FACT_ORDER.filter((f) => found.has(f));
}

// The exchange a transaction traded on, from the addresses involved: Uniswap
// v3's Swap event is emitted, byte for byte, by every fork of it.
function venueOf(ctx: TxContext): string {
  if ((ctx.to !== null && UNISWAP_ENTRY_POINTS.has(ctx.to)) || ctx.emitters.includes(UNISWAP_V4_POOL_MANAGER)) {
    return 'Uniswap';
  }
  for (const factory of Object.values(ctx.factories)) {
    const name = FACTORY_NAMES.get(factory);
    if (name) return name;
  }
  return '';
}

// A short name for who handled the transaction, or '' when no known protocol
// did. Radar also says "USDC" for a direct USDC call; the worker names the
// indexed contract that was called instead (see describeEvent).
export function protocolOf(ctx: TxContext | null): string {
  if (!ctx) return '';
  const topics = new Set(ctx.topics);
  for (const [name, selectors, events] of PROTOCOL_RULES) {
    if (selectors.has(ctx.selector) || [...events].some((e) => topics.has(e))) return name;
  }
  return venueOf(ctx);
}
```

The `/* ... */` and `// ...` markers above stand for the literal entries of the matching Python tables — copy each one, value and comment, from `radar/radar/signatures.py`. The parity test is what proves the copy complete.

- [ ] **Step 5: Write `packages/core/src/insights/sentence.ts`**

```ts
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
const PLAIN_SELECTORS: ReadonlySet<string> = new Set(['0x', '0xa9059cbb', '0x23b872dd']); // empty, transfer, transferFrom

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
```

- [ ] **Step 6: Export from `packages/core/src/index.ts`** (append)

```ts
export {
  FACT_BY_SELECTOR,
  FACT_BY_TOPIC,
  FACT_ORDER,
  FACT_PHRASE,
  FACTORY_CALL,
  POOL_TOPICS,
  factsOf,
  protocolOf,
  type Fact,
  type TxContext,
} from './insights/signatures.js';
export {
  TRANSFER_TOPIC,
  ZERO_ADDRESS,
  amountBucket,
  describeEvent,
  isTransferEvent,
  type CallInfo,
  type DescribeInput,
  type Description,
  type TokenInfo,
  type TransferFields,
} from './insights/sentence.js';
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @arckive/core test -- insights`
Expected: PASS, every parity case included. A failing parity case names the sentence that differs — fix the port, never the fixture.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/insights packages/core/src/index.ts packages/core/test/insights-parity.test.ts packages/core/test/insights-sentence.test.ts
git commit -m "feat(core): Radar's facts and lane sentence for any indexed event"
```

---

### Task 3: Lanes, insight DDL and ABI function names

**Files:**
- Create: `packages/core/src/insights/lanes.ts`
- Modify: `packages/core/src/ddl.ts` (append `buildInsightsTables`)
- Modify: `packages/core/src/abi.ts` (append `extractFunctionNames`)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/insights-lanes.test.ts`

**Interfaces:**
- Produces: `LANES`, `LANE_QUESTION`, `UNCERTAIN_BELOW`, `interface LaneAnswer { choice: string; probabilities: Record<string, number> }`, `interface SettledLane { lane: string; laneP: number | null }`, `settleLane(answer: LaneAnswer | null, ruled: string): SettledLane`, `buildInsightsTables(schema: string): string[]`, `extractFunctionNames(abi: unknown): Map<string, string>` (selector → name)

- [ ] **Step 1: Write the failing tests** — `packages/core/test/insights-lanes.test.ts`

```ts
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
    expect(sql).toContain('UNIQUE (block_number, tx_hash, log_index)');
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
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @arckive/core test -- insights-lanes`
Expected: FAIL — `LANES` not exported.

- [ ] **Step 3: Write `packages/core/src/insights/lanes.ts`**

```ts
// The question the model answers about every unruled event, ported verbatim
// from radar/radar/classify.py. Measured there on ten minutes of Arc mainnet
// (16,632 transfers) against an audited fact table: 99.9% agreement.
//
// The order is part of the question: moving spam first cost 14 points. Spam is
// offered but never decided by the model — removing the option cost accuracy
// elsewhere, so it stays last, as a sink. Mint and burn are not offered: as an
// option it drew probability from every lane; the transfer decides it. Laya
// clamps its temperature at 11 or more options, so the set stays at ten or
// fewer.
export const LANES: Readonly<Record<string, string>> = {
  swap: 'tokens were swapped on an exchange or traded on a marketplace',
  bridge: 'funds were sent to or arrived from another chain through a bridge, even if tokens were also swapped',
  liquidity: 'pool liquidity changed, even if tokens were also swapped',
  vault: 'funds were deposited into or withdrawn from a vault, or USDC was wrapped or unwrapped',
  lending: 'a loan was opened, repaid or liquidated',
  signed_payment: 'the payer signed an authorization and someone else submitted it',
  payment: 'a plain direct transfer, with nothing else happening',
  spam: 'zero or less than one cent of USDC moved and nothing else recognisable happened',
};

export const LANE_QUESTION = {
  type: 'choice',
  instructions: 'What kind of Arc transaction is this?',
  criteria: LANES,
} as const;

// Below this the lane is uncertain rather than guessed (radar/radar/server.py).
export const UNCERTAIN_BELOW = 0.35;

export interface LaneAnswer {
  choice: string;
  probabilities: Record<string, number>;
}

export interface SettledLane {
  lane: string;
  laneP: number | null; // null when ruled or unanswered
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// Radar's settle_lane. A ruled lane stands, with no confidence. The model's
// choice stands unless it is spam — the transfer's call, not the model's — in
// which case its runner-up does; anything outside the set, or too weak to
// stand on, is uncertain.
export function settleLane(answer: LaneAnswer | null, ruled: string): SettledLane {
  if (ruled) return { lane: ruled, laneP: null };
  if (!answer) return { lane: 'uncertain', laneP: null };
  const probabilities = Object.entries(answer.probabilities);
  let lane = answer.choice;
  let p = probabilities.length ? Math.max(...probabilities.map(([, v]) => v)) : 0;
  if (lane === 'spam') {
    const rest = probabilities.filter(([k]) => Object.hasOwn(LANES, k) && k !== 'spam');
    if (!rest.length) return { lane: 'uncertain', laneP: 0 };
    [lane, p] = rest.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  }
  p = round3(p);
  if (!Object.hasOwn(LANES, lane) || p < UNCERTAIN_BELOW) return { lane: 'uncertain', laneP: p };
  return { lane, laneP: p };
}
```

- [ ] **Step 4: Append `buildInsightsTables` to `packages/core/src/ddl.ts`**

```ts
// Insights live beside the event tables, never in them: event tables keep
// their hot-path shape, and "not classified yet" is simply "no row". Keyed
// like the event rows, so any event table joins on (block_number, tx_hash,
// log_index).
export function buildInsightsTables(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q('_insights')} (
  block_number bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  table_name text NOT NULL,
  lane text NOT NULL,
  lane_p real,
  ruled boolean NOT NULL,
  protocol text NOT NULL,
  facts jsonb NOT NULL,
  probabilities jsonb,
  sentence text NOT NULL,
  model text,
  classified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (block_number, tx_hash, log_index)
)`,
    `CREATE INDEX IF NOT EXISTS ${q('_insights_lane_idx')} ON ${q(schema)}.${q('_insights')} (lane)`,
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q('_insights_cursor')} (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
  ];
}
```

- [ ] **Step 5: Append `extractFunctionNames` to `packages/core/src/abi.ts`**

Change the viem import to `import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from 'viem';` and append:

```ts
// selector -> function name, so an insight can say which function of an
// indexed contract a transaction called.
export function extractFunctionNames(abi: unknown): Map<string, string> {
  if (!Array.isArray(abi)) throw new AbiError('ABI must be a JSON array');
  const names = new Map<string, string>();
  for (const entry of abi) {
    if ((entry as { type?: string } | null)?.type !== 'function') continue;
    const fn = entry as AbiFunction;
    names.set(toFunctionSelector(fn), fn.name);
  }
  return names;
}
```

- [ ] **Step 6: Export** — in `packages/core/src/index.ts` change the abi export line to `export { AbiError, extractEventDefs, extractFunctionNames, type EventDef } from './abi.js';`, add `buildInsightsTables,` to the ddl export list, and append:

```ts
export {
  LANES,
  LANE_QUESTION,
  UNCERTAIN_BELOW,
  settleLane,
  type LaneAnswer,
  type SettledLane,
} from './insights/lanes.js';
```

- [ ] **Step 7: Run all core tests**

Run: `pnpm --filter @arckive/core test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src packages/core/test/insights-lanes.test.ts
git commit -m "feat(core): lane question, settling and the _insights tables"
```

---

### Task 4: Configuration surface (CRD → zod → worker config → Deployment)

**Files:**
- Modify: `charts/arckive/crds/indexer.yaml`, `packages/core/src/config.ts`, `packages/core/src/crd.ts`, `packages/operator/src/resources.ts`, `packages/operator/src/reconcile.ts`, `install.yaml` (regenerated)
- Test: `packages/core/test/crd.test.ts`, `packages/operator/test/resources.test.ts`, `packages/operator/test/reconcile.test.ts`, `packages/operator/test/crd-manifest.test.ts`

**Interfaces:**
- Produces: `WorkerConfig.insights?: { laya: { url: string } }`; `IndexerSpec.insights?: { laya: { url: string; headerSecretRef?: { name: string; key: string } } }`; env `INSIGHTS_HEADER`; condition reason `MissingInsightsSecret`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/crd.test.ts` (inside the file, new `describe`):

```ts
describe('insights', () => {
  const withInsights = {
    ...raw,
    insights: { laya: { url: 'https://laya-gate.example', headerSecretRef: { name: 'laya-gate' } } },
  };

  it('defaults the header key and carries only the URL to the worker', () => {
    const spec = IndexerSpecSchema.parse(withInsights);
    expect(spec.insights?.laya.headerSecretRef?.key).toBe('header');
    const cfg = renderWorkerConfig('demo', spec);
    expect(cfg.insights).toEqual({ laya: { url: 'https://laya-gate.example' } });
    expect(JSON.stringify(cfg)).not.toContain('laya-gate"');
  });

  it('rejects a URL that is not http(s)', () => {
    const bad = { ...raw, insights: { laya: { url: 'ftp://x' } } };
    expect(IndexerSpecSchema.safeParse(bad).success).toBe(false);
  });

  it('without insights the worker config and its hash are unchanged', () => {
    const cfg = renderWorkerConfig('demo', IndexerSpecSchema.parse(raw));
    expect('insights' in cfg).toBe(false);
    expect(configHash(cfg)).toBe(configHash(WorkerConfigSchema.parse(JSON.parse(JSON.stringify(cfg)))));
  });
});
```

Append to `packages/operator/test/resources.test.ts`:

```ts
describe('desiredResources — insights', () => {
  const withInsights = IndexerSpecSchema.parse({
    ...spec,
    insights: { laya: { url: 'https://laya-gate.example', headerSecretRef: { name: 'laya-gate' } } },
  });
  const env = (s: typeof spec) =>
    desiredResources({ ...input, spec: s }).deployment.spec!.template.spec!.containers[0]!.env!;

  it('the header comes from its Secret and never reaches the ConfigMap', () => {
    expect(env(withInsights).find((e) => e.name === 'INSIGHTS_HEADER')).toEqual({
      name: 'INSIGHTS_HEADER',
      valueFrom: { secretKeyRef: { name: 'laya-gate', key: 'header' } },
    });
    const cm = desiredResources({ ...input, spec: withInsights }).configMap.data!['config.json']!;
    expect(JSON.parse(cm).insights).toEqual({ laya: { url: 'https://laya-gate.example' } });
  });

  it('no INSIGHTS_HEADER without insights', () => {
    expect(env(spec).map((e) => e.name)).not.toContain('INSIGHTS_HEADER');
  });
});
```

Append to `packages/operator/test/reconcile.test.ts` inside `describe('reconcile', …)`:

```ts
  it('missing insights header Secret: Provisioned=False/MissingInsightsSecret', async () => {
    const kube = makeFake();
    const cr = makeCr();
    cr.spec!.insights = { laya: { url: 'https://laya-gate.example', headerSecretRef: { name: 'laya-gate', key: 'header' } } };
    await reconcile({ kube, workerImage: 'w:test', log }, cr);
    expect(kube.applied).toEqual([]);
    expect(kube.statusPatches[0]!.conditions?.[0]!.reason).toBe('MissingInsightsSecret');
  });

  it('insights header Secret present: reconciles', async () => {
    const kube = makeFake({ secrets: { 'pg-dsn': { url: 'ZHNu' }, 'laya-gate': { header: 'eA==' } } });
    const cr = makeCr();
    cr.spec!.insights = { laya: { url: 'https://laya-gate.example', headerSecretRef: { name: 'laya-gate', key: 'header' } } };
    await reconcile({ kube, workerImage: 'w:test', log }, cr);
    expect(kube.applied).toHaveLength(5);
  });
```

In `packages/operator/test/crd-manifest.test.ts` change the expected key list to `['contracts', 'insights', 'network', 'polling', 'storage']`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @arckive/core build && pnpm --filter @arckive/core test -- crd && pnpm --filter @arckive/operator test`
Expected: FAIL — `insights` stripped by zod / not in CRD.

- [ ] **Step 3: Implement**

`packages/core/src/config.ts`, inside `WorkerConfigSchema` after `polling`:

```ts
  // Laya insights (optional): where the model gate is. The header that
  // authenticates to it is a secret and arrives as INSIGHTS_HEADER, never here.
  insights: z
    .object({
      laya: z.object({
        url: z.string().regex(/^https?:\/\//i, 'insights.laya.url must be http(s)://'),
      }),
    })
    .optional(),
```

`packages/core/src/crd.ts`, inside `IndexerSpecSchema` after `polling`:

```ts
  // Classify every indexed event's transaction into a lane through a Laya
  // model gate. Only the URL reaches the worker's config; the header (a token)
  // stays in its Secret and is injected as env.
  insights: z
    .object({
      laya: z.object({
        url: z.string().regex(/^https?:\/\//i, 'insights.laya.url must be http(s)://'),
        headerSecretRef: z
          .object({ name: z.string().min(1), key: z.string().min(1).default('header') })
          .optional(),
      }),
    })
    .optional(),
```

and in `renderWorkerConfig`, after `polling: spec.polling,`:

```ts
    ...(spec.insights ? { insights: { laya: { url: spec.insights.laya.url } } } : {}),
```

`packages/operator/src/resources.ts`: before `const deployment`, add `const insightsHeader = spec.insights?.laya.headerSecretRef;` and in the container `env` array after the `INDEXER_CR_NAMESPACE` entry:

```ts
                // the gate's header carries a token: Secret -> env, never the ConfigMap
                ...(insightsHeader
                  ? [{
                      name: 'INSIGHTS_HEADER',
                      valueFrom: { secretKeyRef: { name: insightsHeader.name, key: insightsHeader.key } },
                    }]
                  : []),
```

`packages/operator/src/reconcile.ts`, after the DSN Secret check:

```ts
  const headerRef = spec.insights?.laya.headerSecretRef;
  if (headerRef) {
    const headerSecret = await deps.kube.getSecret(namespace, headerRef.name);
    if (!headerSecret?.data?.[headerRef.key]) {
      await setCondition(
        condition('False', 'MissingInsightsSecret', `Secret ${headerRef.name}/${headerRef.key} not found`),
      );
      return;
    }
  }
```

`charts/arckive/crds/indexer.yaml`, under `spec.properties` after `polling`:

```yaml
                insights:
                  type: object
                  description: "Laya insights: classify every indexed event's transaction into a lane (swap, bridge, …) through a Laya model gate"
                  required: [laya]
                  properties:
                    laya:
                      type: object
                      required: [url]
                      properties:
                        url:
                          type: string
                          pattern: '^https?://'
                          description: "base URL of the Laya gate; /ai/run/batch and /health are appended"
                        headerSecretRef:
                          type: object
                          description: "Secret whose value is one header line sent to the gate, e.g. 'Authorization: Bearer …'"
                          required: [name]
                          properties:
                            name:
                              type: string
                            key:
                              type: string
                              default: header
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @arckive/core build && pnpm --filter @arckive/core test && pnpm --filter @arckive/operator test`
Expected: PASS.

- [ ] **Step 5: Regenerate install.yaml**

Run: `scripts/build-install.sh && git diff --stat install.yaml`
Expected: only the CRD's `insights` block added.

- [ ] **Step 6: Commit**

```bash
git add charts/arckive/crds/indexer.yaml packages/core/src/config.ts packages/core/src/crd.ts packages/core/test/crd.test.ts packages/operator install.yaml
git commit -m "feat: spec.insights.laya — gate URL in config, header from a Secret"
```

---

### Task 5: Laya gate client

**Files:**
- Create: `packages/worker/src/laya.ts`
- Test: `packages/worker/test/laya.test.ts`

**Interfaces:**
- Consumes: `LANE_QUESTION`, `LaneAnswer` from core.
- Produces: `class LayaError extends Error { status?: number }`, `interface HeaderLine { name: string; value: string }`, `parseHeaderLine(line: string): HeaderLine`, `BATCH_MAX = 64`, `MIN_CALL_INTERVAL_MS = 1000`, `interface LayaDeps { fetch?; now?; sleep?; onCall?; onCacheHits? }`, `class LayaClient { constructor(url: string, header: HeaderLine | null, deps?: LayaDeps); classify(sentences: string[]): Promise<Map<string, LaneAnswer>>; identity(): Promise<string | null> }`

- [ ] **Step 1: Write the failing tests** — `packages/worker/test/laya.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { LANE_QUESTION } from '@arckive/core';
import { BATCH_MAX, LayaClient, LayaError, parseHeaderLine } from '../src/laya.js';

interface Call { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

const lanesFor = (init: RequestInit) => {
  const { states } = JSON.parse(String(init.body)) as { states: string[] };
  return new Response(JSON.stringify({
    results: states.map(() => ({ answers: { lane: { choice: 'swap', probabilities: { swap: 0.9, bridge: 0.1 } } } })),
  }));
};

function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { slept.push(ms); t += ms; },
    slept,
  };
}

describe('parseHeaderLine', () => {
  it('splits at the first colon and trims', () => {
    expect(parseHeaderLine('Authorization: Bearer a:b')).toEqual({ name: 'Authorization', value: 'Bearer a:b' });
    expect(parseHeaderLine('X-Api-Key:k')).toEqual({ name: 'X-Api-Key', value: 'k' });
  });

  it('refuses a malformed line without echoing it', () => {
    for (const bad of ['no-colon secret-token', ': secret-token', 'Bad Name: secret-token']) {
      expect(() => parseHeaderLine(bad)).toThrow(LayaError);
      try { parseHeaderLine(bad); } catch (err) { expect(String(err)).not.toContain('secret-token'); }
    }
  });
});

describe('LayaClient.classify', () => {
  it('posts the lane question with the header and a fixed User-Agent', async () => {
    const f = fakeFetch((_u, init) => lanesFor(init));
    const client = new LayaClient('https://gate.example/', { name: 'Authorization', value: 'Bearer t' }, { fetch: f.fn });
    const out = await client.classify(['a', 'b', 'a']);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://gate.example/ai/run/batch');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer t');
    expect(headers['user-agent']).toBe('arckive-worker');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ states: ['a', 'b'], questions: { lane: LANE_QUESTION } });
    expect(out.get('a')).toEqual({ choice: 'swap', probabilities: { swap: 0.9, bridge: 0.1 } });
  });

  it('sends at most 64 states a call, a second apart', async () => {
    const f = fakeFetch((_u, init) => lanesFor(init));
    const clock = fakeClock();
    let calls = 0;
    const client = new LayaClient('https://g', null, { fetch: f.fn, now: clock.now, sleep: clock.sleep, onCall: () => calls++ });
    const sentences = Array.from({ length: BATCH_MAX * 2 + 2 }, (_, i) => `s${i}`);
    const out = await client.classify(sentences);
    expect(out.size).toBe(sentences.length);
    expect(f.calls.map((c) => (JSON.parse(String(c.init.body)) as { states: string[] }).states.length)).toEqual([64, 64, 2]);
    expect(clock.slept).toEqual([1000, 1000]);
    expect(calls).toBe(3);
  });

  it('answers a sentence it has seen from the cache', async () => {
    const f = fakeFetch((_u, init) => lanesFor(init));
    let hits = 0;
    const client = new LayaClient('https://g', null, { fetch: f.fn, onCacheHits: (n) => (hits += n) });
    await client.classify(['a', 'b']);
    await client.classify(['b', 'c']);
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(String(f.calls[1]!.init.body)).states).toEqual(['c']);
    expect(hits).toBe(1);
  });

  it('turns HTTP errors, bad bodies and unreachable gates into LayaError', async () => {
    const status = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response('no', { status: 401 })).fn });
    await expect(status.classify(['a'])).rejects.toMatchObject({ name: 'LayaError', status: 401 });
    const short = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response(JSON.stringify({ results: [] }))).fn });
    await expect(short.classify(['a'])).rejects.toBeInstanceOf(LayaError);
    const down = new LayaClient('https://g', null, { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.classify(['a'])).rejects.toBeInstanceOf(LayaError);
  });
});

describe('LayaClient.identity', () => {
  it('reads the model name, or null when the gate does not say', async () => {
    const ok = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response(JSON.stringify({ model: 'laya-322m' }))).fn });
    expect(await ok.identity()).toBe('laya-322m');
    const down = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response('', { status: 503 })).fn });
    expect(await down.identity()).toBeNull();
  });
});
```

`LayaError` must set `this.name = 'LayaError'` so `toMatchObject({ name })` holds.

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @arckive/worker test -- laya`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/worker/src/laya.ts`**

```ts
import { z } from 'zod';
import { LANE_QUESTION, type LaneAnswer } from '@arckive/core';

// Client for a Laya model gate (radar/radar/modelgate.py in front of layad):
// POST /ai/run/batch answers one question for many sentences, GET /health
// names the model. The gate is shared with live radars and allows 240 calls a
// minute across everyone, so this client stays well inside that on its own.

export class LayaError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LayaError';
    this.status = status;
  }
}

export interface HeaderLine {
  name: string;
  value: string;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// INSIGHTS_HEADER is a whole header line, "Name: value". The value is a
// secret: no error here repeats any of the line.
export function parseHeaderLine(line: string): HeaderLine {
  const i = line.indexOf(':');
  const name = i > 0 ? line.slice(0, i).trim() : '';
  if (!name || !TOKEN.test(name)) {
    throw new LayaError('INSIGHTS_HEADER must be one header line, "Name: value"');
  }
  return { name, value: line.slice(i + 1).trim() };
}

const BatchResponse = z.object({
  results: z.array(
    z.object({
      answers: z.object({
        lane: z.object({ choice: z.string(), probabilities: z.record(z.number()) }),
      }),
    }),
  ),
});

// A large batch holds the shared GPU for seconds and starves the radars on it
// (radar/radar/server.py BATCH_MAX).
export const BATCH_MAX = 64;
// One call a second at most: a quarter of the gate's shared budget.
export const MIN_CALL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 30_000;
const CACHE_MAX = 60_000;

export interface LayaDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onCall?: () => void;
  onCacheHits?: (n: number) => void;
}

export class LayaClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  // Real traffic repeats a handful of shapes thousands of times; answers are
  // kept per exact sentence (the question never changes), least recent first.
  private readonly cache = new Map<string, LaneAnswer>();
  private lastCallAt = -Infinity;

  constructor(url: string, header: HeaderLine | null, private readonly deps: LayaDeps = {}) {
    this.base = url.replace(/\/+$/, '');
    // Cloudflare in front of the tunnel refuses some clients by their default
    // User-Agent before the request reaches the gate.
    this.headers = { 'user-agent': 'arckive-worker', ...(header ? { [header.name]: header.value } : {}) };
  }

  async classify(sentences: string[]): Promise<Map<string, LaneAnswer>> {
    const out = new Map<string, LaneAnswer>();
    const unseen: string[] = [];
    for (const s of new Set(sentences)) {
      const hit = this.cache.get(s);
      if (hit) {
        this.cache.delete(s);
        this.cache.set(s, hit);
        out.set(s, hit);
      } else {
        unseen.push(s);
      }
    }
    if (out.size) this.deps.onCacheHits?.(out.size);
    for (let i = 0; i < unseen.length; i += BATCH_MAX) {
      const chunk = unseen.slice(i, i + BATCH_MAX);
      const answers = await this.ask(chunk);
      chunk.forEach((s, j) => {
        out.set(s, answers[j]!);
        this.cache.set(s, answers[j]!);
      });
    }
    // Trimmed after the round is answered, so nothing this round needs is evicted first.
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  async identity(): Promise<string | null> {
    try {
      const body = (await this.request('/health', { headers: this.headers })) as { model?: unknown } | null;
      return typeof body?.model === 'string' ? body.model : null;
    } catch {
      return null;
    }
  }

  private async ask(states: string[]): Promise<LaneAnswer[]> {
    await this.pace();
    this.deps.onCall?.();
    const body = await this.request('/ai/run/batch', {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ states, questions: { lane: LANE_QUESTION } }),
    });
    const parsed = BatchResponse.safeParse(body);
    if (!parsed.success || parsed.data.results.length !== states.length) {
      throw new LayaError('gate answered an unexpected body');
    }
    return parsed.data.results.map((r) => r.answers.lane);
  }

  private async pace(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = this.lastCallAt + MIN_CALL_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = now();
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new LayaError(`gate unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, undefined, { cause });
    }
    if (!res.ok) throw new LayaError(`gate answered HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch (cause) {
      throw new LayaError('gate answered a body that is not JSON', undefined, { cause });
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @arckive/worker test -- laya`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/laya.ts packages/worker/test/laya.test.ts
git commit -m "feat(worker): Laya gate client — header, pacing, per-sentence cache"
```

---

### Task 6: Transaction context over RPC

**Files:**
- Create: `packages/worker/src/txcontext.ts`
- Create: `packages/worker/test/fixtures/emitter/src/Insights.sol`
- Test: `packages/worker/test/txcontext.test.ts`

**Interfaces:**
- Consumes: `FACTORY_CALL`, `POOL_TOPICS`, `ZERO_ADDRESS`, `TokenInfo`, `TxContext` from core.
- Produces: `isContractCode(code: string | undefined): boolean`, `tokenLabel(symbol: string | null, fallback: string): string`, `interface ContextSource { contexts(txHashes: readonly string[]): Promise<Map<string, TxContext | null>>; partyKinds(addresses: readonly string[]): Promise<Record<string, boolean>> }`, `createContextSource(client: PublicClient, now?: () => number): ContextSource`, `readTokenInfo(client: PublicClient, address: string, fallback: string): Promise<TokenInfo>`

- [ ] **Step 1: Write the Solidity fixture** — `packages/worker/test/fixtures/emitter/src/Insights.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Just real enough for the worker's insight context: the token logs ERC-20
// Transfers and answers symbol()/decimals(); the pool logs Uniswap v3's Swap
// event and answers factory() with Aerodrome's factory, so a swap through it
// reads as a swap on Aerodrome.
contract Token {
    event Transfer(address indexed from, address indexed to, uint256 value);

    string public symbol = "TKN";
    uint8 public decimals = 6;

    function transfer(address to, uint256 value) external returns (bool) {
        emit Transfer(msg.sender, to, value);
        return true;
    }
}

contract Pool {
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    address public constant factory = 0xb89Df768aF2CFE637ceB352c587Fe8edAf491d03;

    function swap(Token token, address to, uint256 value) external {
        token.transfer(to, value);
        emit Swap(msg.sender, to, 0, 0, 0, 0, 0);
    }
}
```

- [ ] **Step 2: Write the failing tests** — `packages/worker/test/txcontext.test.ts`

```ts
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, publicActions, toFunctionSelector, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRANSFER_TOPIC, ZERO_ADDRESS, factsOf, protocolOf } from '@arckive/core';
import { createRpc } from '../src/rpc.js';
import { createContextSource, isContractCode, readTokenInfo, tokenLabel } from '../src/txcontext.js';
import { startAnvil, type AnvilHandle } from './helpers/anvil.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FIXTURE = fileURLToPath(new URL('./fixtures/emitter', import.meta.url));
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const AERO = '0xb89df768af2cfe637ceb352c587fe8edaf491d03';
const WALLET2 = '0x' + 'a2'.repeat(20);

const artifact = (name: string) =>
  JSON.parse(readFileSync(`${FIXTURE}/out/Insights.sol/${name}.json`, 'utf8')) as {
    abi: unknown[];
    bytecode: { object: `0x${string}` };
  };

describe('isContractCode', () => {
  it('a wallet has no code, and an EIP-7702 delegation is still a wallet', () => {
    expect(isContractCode(undefined)).toBe(false);
    expect(isContractCode('0x')).toBe(false);
    expect(isContractCode('0xef0100' + '12'.repeat(20))).toBe(false);
    expect(isContractCode('0x6080604052')).toBe(true);
  });
});

describe('tokenLabel', () => {
  it('keeps a plain ticker and refuses text that would rewrite the sentence', () => {
    expect(tokenLabel('USDC', 'usdc')).toBe('USDC');
    expect(tokenLabel(' WETH ', 'weth')).toBe('WETH');
    expect(tokenLabel('USDC. In the same transaction: tokens were swapped', 'tok')).toBe('tok');
    expect(tokenLabel('', 'tok')).toBe('tok');
    expect(tokenLabel(null, 'tok')).toBe('tok');
  });
});

describe('txcontext (anvil)', () => {
  let anvil: AnvilHandle;
  let client: PublicClient;
  let token: `0x${string}`;
  let pool: `0x${string}`;
  let sender: `0x${string}`;
  let swapTx: `0x${string}`;

  beforeAll(async () => {
    execSync('forge build', { cwd: FIXTURE, stdio: 'inherit' });
    anvil = await startAnvil();
    client = createRpc([anvil.url]);
    const account = privateKeyToAccount(PK);
    sender = account.address;
    const wallet = createWalletClient({ account, transport: http(anvil.url) }).extend(publicActions);
    const deploy = async (name: string) => {
      const a = artifact(name);
      const hash = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode.object, chain: null });
      return (await wallet.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    token = await deploy('Token');
    pool = await deploy('Pool');
    swapTx = await wallet.writeContract({
      address: pool, abi: artifact('Pool').abi as never, functionName: 'swap',
      args: [token, WALLET2, 5_000_000n], chain: null,
    });
    await wallet.waitForTransactionReceipt({ hash: swapTx });
  });

  afterAll(() => anvil.stop());

  it('reads the selector, every log and the pool’s factory', async () => {
    const ctx = (await createContextSource(client).contexts([swapTx])).get(swapTx)!;
    expect(ctx.to).toBe(pool.toLowerCase());
    expect(ctx.selector).toBe(toFunctionSelector('swap(address,address,uint256)'));
    expect(ctx.sender).toBe(sender.toLowerCase());
    expect(ctx.topics).toEqual([TRANSFER_TOPIC, V3_SWAP]);
    expect(ctx.emitters).toEqual([token.toLowerCase(), pool.toLowerCase()]);
    expect(ctx.factories).toEqual({ [pool.toLowerCase()]: AERO });
    expect(factsOf(ctx)).toEqual(['swap']);
    expect(protocolOf(ctx)).toBe('Aerodrome');
  });

  it('a transaction the node does not have has no context', async () => {
    const missing = `0x${'11'.repeat(32)}`;
    expect((await createContextSource(client).contexts([missing])).get(missing)).toBeNull();
  });

  it('tells wallets from contracts and skips the zero address', async () => {
    const kinds = await createContextSource(client).partyKinds([sender.toLowerCase(), pool.toLowerCase(), ZERO_ADDRESS]);
    expect(kinds).toEqual({ [sender.toLowerCase()]: false, [pool.toLowerCase()]: true });
  });

  it('reads symbol and decimals, and falls back for what is not a token', async () => {
    expect(await readTokenInfo(client, token, 'tok')).toEqual({ label: 'TKN', decimals: 6 });
    expect(await readTokenInfo(client, sender, 'mytoken')).toEqual({ label: 'mytoken', decimals: null });
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `pnpm --filter @arckive/worker test -- txcontext`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `packages/worker/src/txcontext.ts`**

```ts
import {
  TransactionNotFoundError, TransactionReceiptNotFoundError, erc20Abi, type PublicClient,
} from 'viem';
import { FACTORY_CALL, POOL_TOPICS, ZERO_ADDRESS, type TokenInfo, type TxContext } from '@arckive/core';

// What the insight loop needs to know about a transaction beyond its own
// event: the function called, every event logged, who deployed the pools it
// touched, and whether each transfer party is a wallet or a contract. Ported
// from radar/radar/arc.py (_items).

const CONC = 8;
const CACHE_MAX = 50_000;
// A pool that cannot answer factory() fails the same way every time; asked
// again only after this long.
const FACTORY_RETRY_MS = 600_000;

// An EIP-7702 account carries code too — 0xef0100 and the address it
// delegates to, 23 bytes — but it is still somebody's wallet with a key. On
// mainnet 268 of 663 addresses with code were these; calling them contracts
// told the model a payment between two people went contract to contract.
export function isContractCode(code: string | undefined): boolean {
  if (!code || code === '0x' || code === '0x0') return false;
  return !(code.toLowerCase().startsWith('0xef0100') && code.length === 2 + 2 * 23);
}

// symbol() is text anyone deploying a token chooses, and it lands in the
// sentence the model reads. Only a short plain ticker is used as one.
export function tokenLabel(symbol: string | null, fallback: string): string {
  const s = symbol?.trim() ?? '';
  return /^[A-Za-z0-9$._-]{1,16}$/.test(s) ? s : fallback;
}

export async function readTokenInfo(client: PublicClient, address: string, fallback: string): Promise<TokenInfo> {
  const at = address as `0x${string}`;
  const [symbol, decimals] = await Promise.allSettled([
    client.readContract({ address: at, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: at, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return {
    label: tokenLabel(symbol.status === 'fulfilled' ? symbol.value : null, fallback),
    decimals: decimals.status === 'fulfilled' ? decimals.value : null,
  };
}

export interface ContextSource {
  // null for a transaction the node does not have; an RPC failure rejects.
  contexts(txHashes: readonly string[]): Promise<Map<string, TxContext | null>>;
  // address -> is a contract; the zero address is never asked about.
  partyKinds(addresses: readonly string[]): Promise<Record<string, boolean>>;
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONC) out.push(...(await Promise.all(items.slice(i, i + CONC).map(fn))));
  return out;
}

export function createContextSource(client: PublicClient, now: () => number = Date.now): ContextSource {
  const codes = new Lru<boolean>(CACHE_MAX);
  const factories = new Lru<string>(CACHE_MAX);
  const unreadable = new Map<string, number>(); // pool -> when factory() may be asked again

  async function read(hash: string): Promise<TxContext | null> {
    const h = hash as `0x${string}`;
    let tx, receipt;
    try {
      [tx, receipt] = await Promise.all([client.getTransaction({ hash: h }), client.getTransactionReceipt({ hash: h })]);
    } catch (err) {
      if (err instanceof TransactionNotFoundError || err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
    const logs = receipt.logs.filter((l) => l.topics.length > 0);
    const input = tx.input ?? '0x';
    return {
      to: tx.to ? tx.to.toLowerCase() : null,
      selector: input.length >= 10 ? input.slice(0, 10).toLowerCase() : '0x',
      topics: logs.map((l) => l.topics[0]!.toLowerCase()),
      sender: tx.from.toLowerCase(),
      emitters: logs.map((l) => l.address.toLowerCase()),
      factories: {},
    };
  }

  // Which exchange a swap happened on is a fact about the pool, not about the
  // event it logs: Uniswap v3's Swap is logged, byte for byte, by every fork.
  async function askFactory(pool: string): Promise<void> {
    try {
      const { data } = await client.call({ to: pool as `0x${string}`, data: FACTORY_CALL });
      if (data && data.length >= 42) {
        factories.set(pool, `0x${data.slice(-40).toLowerCase()}`);
        unreadable.delete(pool);
        return;
      }
    } catch {
      // a contract that logs a pool event but has no factory() — retried later
    }
    unreadable.set(pool, now() + FACTORY_RETRY_MS);
  }

  return {
    async contexts(txHashes) {
      const hashes = [...new Set(txHashes)];
      const ctxs = await mapLimit(hashes, read);
      const poolsOf = ctxs.map((c) =>
        c ? [...new Set(c.emitters.filter((e, i) => e && POOL_TOPICS.has(c.topics[i]!)))] : [],
      );
      const clock = now();
      const ask = [...new Set(poolsOf.flat())].filter(
        (p) => factories.get(p) === undefined && (unreadable.get(p) ?? 0) <= clock,
      );
      await mapLimit(ask, askFactory);
      if (unreadable.size > 10_000) {
        for (const [p, until] of unreadable) if (until <= clock) unreadable.delete(p);
      }
      const out = new Map<string, TxContext | null>();
      hashes.forEach((h, i) => {
        const c = ctxs[i] ?? null;
        if (c) {
          for (const p of poolsOf[i]!) {
            const f = factories.get(p);
            if (f) c.factories[p] = f;
          }
        }
        out.set(h, c);
      });
      return out;
    },

    async partyKinds(addresses) {
      const wanted = [...new Set(addresses)].filter((a) => a !== ZERO_ADDRESS);
      const unknown = wanted.filter((a) => codes.get(a) === undefined);
      const got = await mapLimit(unknown, (a) => client.getCode({ address: a as `0x${string}` }));
      unknown.forEach((a, i) => codes.set(a, isContractCode(got[i])));
      const out: Record<string, boolean> = {};
      for (const a of wanted) {
        const v = codes.get(a);
        if (v !== undefined) out[a] = v;
      }
      return out;
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @arckive/worker test -- txcontext`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/txcontext.ts packages/worker/test/txcontext.test.ts packages/worker/test/fixtures/emitter/src/Insights.sol
git commit -m "feat(worker): transaction context for insights — logs, pools, parties, token info"
```

---

### Task 7: Insight round and loop

**Files:**
- Create: `packages/worker/src/insightsdb.ts`, `packages/worker/src/insights.ts`
- Modify: `packages/worker/src/metrics.ts`, `packages/worker/src/pipeline.ts` (export `sleep`)
- Test: `packages/worker/test/insights.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 core exports; `ContextSource` (Task 6); `LayaClient`, `LayaError` (Task 5); `getCursor`, `commitBatch`, `initCursor`, `bootstrap` (`db.ts`).
- Produces:
  - `insightsdb.ts`: `interface InsightRow`, `interface EventSource { tableName: string; transferColumns: readonly [string, string, string] | null }`, `interface EventRow`, `bootstrapInsights(pool, schema, start: bigint)`, `getInsightsCursor(pool, schema): Promise<bigint|null>`, `capRange(pool, schema, tables, from, to, maxRows): Promise<bigint>`, `readEventRows(pool, schema, tables, from, to): Promise<EventRow[]>`, `commitInsights(pool, schema, rows, newCursor): Promise<string[]>` (lanes of inserted rows)
  - `insights.ts`: `MAX_ROWS_PER_ROUND = 2000`, `interface InsightTarget extends EventSource { contractName; address; eventName; token: TokenInfo|null }`, `interface CalledContract { name: string; functions: ReadonlyMap<string,string> }`, `type Classifier = Pick<LayaClient,'classify'|'identity'>`, `interface InsightsDeps`, `class InsightsError extends Error { stage: 'model'|'rpc'|'db' }`, `insightTargets(defs, tokens): InsightTarget[]`, `runInsightsOnce(deps, model: string|null): Promise<boolean>`, `runInsightsLoop(deps, signal): Promise<void>`
  - metrics: `insightsBlocksBehind`, `insightsClassified{lane}`, `insightsModelCalls`, `insightsCacheHits`, `insightsErrors{stage}`

- [ ] **Step 1: Write the failing tests** — `packages/worker/test/insights.test.ts`

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSFER_TOPIC, buildControlTables, buildEventTable, extractEventDefs,
  type DecodedRow, type LaneAnswer, type TxContext,
} from '@arckive/core';
import { bootstrap, commitBatch, initCursor } from '../src/db.js';
import {
  InsightsError, insightTargets, runInsightsLoop, runInsightsOnce, type InsightsDeps,
} from '../src/insights.js';
import { bootstrapInsights, capRange, getInsightsCursor } from '../src/insightsdb.js';
import { LayaError } from '../src/laya.js';
import { createMetrics } from '../src/metrics.js';
import { HeadSignal } from '../src/signal.js';
import type { ContextSource } from '../src/txcontext.js';

const SCHEMA = 'idx_ins';
const TOKEN = '0x' + '11'.repeat(20);
const VAULT = '0x' + '22'.repeat(20);
const WALLET = '0x' + 'a1'.repeat(20);
const WALLET2 = '0x' + 'a2'.repeat(20);
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const defs = [
  ...extractEventDefs('tok', TOKEN, [{
    type: 'event', name: 'Transfer', inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  }]),
  ...extractEventDefs('vault', VAULT, [{
    type: 'event', name: 'Deposited', inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  }]),
];

const common = (block: number, n: number, contract: string) => ({
  block_number: String(block), block_hash: `0x${'bb'.repeat(32)}`, block_time: new Date(0),
  tx_hash: tx(n), tx_index: 0, log_index: n, contract_address: contract,
});
const transferRow = (block: number, n: number, value: bigint): DecodedRow => ({
  tableName: 'tok_transfer',
  columns: { ...common(block, n, TOKEN), from: WALLET, to: WALLET2, value: value.toString() },
});
const depositRow = (block: number, n: number): DecodedRow => ({
  tableName: 'vault_deposited',
  columns: { ...common(block, n, VAULT), user: WALLET, amount: '5' },
});

const ctx = (over: Partial<TxContext>): TxContext => ({
  to: TOKEN, selector: '0xa9059cbb', topics: [TRANSFER_TOPIC], sender: WALLET,
  emitters: [TOKEN], factories: {}, ...over,
});

function fakeContext(contexts: Record<string, TxContext | null>): ContextSource {
  return {
    contexts: async (hashes) => new Map(hashes.map((h) => [h, contexts[h] ?? null])),
    partyKinds: async (addrs) => Object.fromEntries(addrs.map((a) => [a, false])),
  };
}

function fakeClassifier() {
  const asked: string[][] = [];
  const state = { fail: null as Error | null };
  return {
    asked,
    state,
    classify: async (sentences: string[]) => {
      if (state.fail) throw state.fail;
      asked.push(sentences);
      return new Map<string, LaneAnswer>(sentences.map((s) => [s, { choice: 'swap', probabilities: { swap: 0.9, bridge: 0.1 } }]));
    },
    identity: async () => 'laya-test',
  };
}

describe('insights', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let classifier: ReturnType<typeof fakeClassifier>;
  let deps: InsightsDeps;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap(pool, buildControlTables(SCHEMA), defs.map((d) => buildEventTable(SCHEMA, d)));
    await initCursor(pool, SCHEMA, 99n);
    await bootstrapInsights(pool, SCHEMA, 99n);
    classifier = fakeClassifier();
    deps = {
      pool, schema: SCHEMA,
      targets: insightTargets(defs, new Map([[TOKEN, { label: 'TKN', decimals: 6 }]])),
      called: new Map([[VAULT, { name: 'vault', functions: new Map([['0x12345678', 'depositFor']]) }]]),
      context: fakeContext({
        [tx(1)]: ctx({ selector: '0x3593564c', to: '0x' + 'c1'.repeat(20), topics: [TRANSFER_TOPIC, V3_SWAP] }),
        [tx(2)]: ctx({}),
        [tx(3)]: ctx({ to: VAULT, selector: '0x12345678', topics: ['0x' + '77'.repeat(32)] }),
        [tx(4)]: ctx({}),
      }),
      classifier,
      metrics: createMetrics('ins'),
      log: pino({ level: 'silent' }),
      batchBlocks: 100,
      intervalMs: 60_000,
      wake: new HeadSignal(),
    };
  });

  const insights = async () =>
    (await pool.query(`SELECT * FROM ${SCHEMA}._insights ORDER BY block_number, log_index`)).rows;

  it('classifies committed rows up to the ingest cursor and no further', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), depositRow(102, 3)], [], 102n);
    await commitBatch(pool, SCHEMA, [transferRow(103, 4, 1n)], [], 102n); // written, not yet committed past
    while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
    const rows = await insights();
    expect(rows.map((r) => r.tx_hash)).toEqual([tx(1), tx(2), tx(3)]);
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(102n);
  });

  it('rules what the transfer decides and asks the model the rest', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), depositRow(102, 3)], [], 102n);
    await runInsightsOnce(deps, 'laya-test');
    const [swap, spam, deposit] = await insights();
    expect(swap).toMatchObject({ lane: 'swap', lane_p: 0.9, ruled: false, protocol: 'Uniswap', facts: ['swap'], model: 'laya-test' });
    expect(swap.probabilities).toEqual({ swap: 0.9, bridge: 0.1 });
    expect(swap.sentence).toBe('TKN moved from a wallet to a wallet, amount 1 to 100 TKN. In the same transaction: tokens were swapped on an exchange.');
    expect(spam).toMatchObject({ lane: 'spam', lane_p: null, ruled: true, probabilities: null, model: null });
    expect(deposit.sentence).toBe('The vault contract logged Deposited. It was called with depositFor. In the same transaction: nothing else recognisable happened.');
    expect(deposit).toMatchObject({ protocol: 'vault', table_name: 'vault_deposited' });
    expect(classifier.asked.flat()).not.toContain(spam.sentence);
  });

  it('a failed model call writes nothing and leaves the cursor', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n)], [], 100n);
    classifier.state.fail = new LayaError('gate answered HTTP 503', 503);
    await expect(runInsightsOnce(deps, null)).rejects.toMatchObject({ stage: 'model' });
    expect(await insights()).toEqual([]);
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(99n);
  });

  it('re-running a range changes nothing', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n), depositRow(101, 3)], [], 101n);
    await runInsightsOnce(deps, 'laya-test');
    await pool.query(`UPDATE ${SCHEMA}._insights_cursor SET last_block = 99`);
    await runInsightsOnce(deps, 'laya-test');
    expect(await insights()).toHaveLength(2);
  });

  it('caps a round by rows, taking an oversized block whole', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 1n), transferRow(100, 2, 1n), depositRow(101, 3), depositRow(103, 4)], [], 103n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 2)).toBe(100n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 3)).toBe(102n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 10)).toBe(103n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 100n, 1)).toBe(100n);
  });

  it('the loop keeps going through gate failures and counts them by stage', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n)], [], 100n);
    classifier.state.fail = new LayaError('gate answered HTTP 401', 401);
    const ctrl = new AbortController();
    const loop = runInsightsLoop(deps, ctrl.signal);
    await expect.poll(async () => (await deps.metrics.insightsErrors.get()).values.find((v) => v.labels.stage === 'model')?.value ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);
    classifier.state.fail = null;
    await expect.poll(async () => (await insights()).length, { timeout: 10_000 }).toBe(1);
    ctrl.abort();
    await loop;
  });

  it('wakes as soon as ingest commits', async () => {
    const ctrl = new AbortController();
    const loop = runInsightsLoop(deps, ctrl.signal);
    await new Promise((r) => setTimeout(r, 200));
    await commitBatch(pool, SCHEMA, [depositRow(100, 3)], [], 100n);
    (deps.wake as HeadSignal).notify();
    await expect.poll(async () => (await insights()).length, { timeout: 3_000 }).toBe(1);
    ctrl.abort();
    await loop;
  });

  it('InsightsError names the stage that failed', () => {
    const err = new InsightsError('rpc', { cause: new Error('boom') });
    expect(err.stage).toBe('rpc');
    expect(err.message).toContain('boom');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @arckive/worker test -- insights.test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Add metrics** — in `packages/worker/src/metrics.ts`, inside the returned object after `writeLatency`:

```ts
    insightsBlocksBehind: new Gauge({
      name: 'arckive_insights_blocks_behind',
      help: 'block gap between the ingest cursor and the insights cursor',
      registers: [registry],
    }),
    insightsClassified: new Counter({
      name: 'arckive_insights_classified_total',
      help: 'insight rows written, by lane',
      labelNames: ['lane'] as const,
      registers: [registry],
    }),
    insightsModelCalls: new Counter({
      name: 'arckive_insights_model_calls_total',
      help: 'calls made to the Laya gate',
      registers: [registry],
    }),
    insightsCacheHits: new Counter({
      name: 'arckive_insights_cache_hits_total',
      help: 'sentences answered from the cache instead of the gate',
      registers: [registry],
    }),
    insightsErrors: new Counter({
      name: 'arckive_insights_errors_total',
      help: 'failed insight rounds, by stage (model, rpc, db)',
      labelNames: ['stage'] as const,
      registers: [registry],
    }),
```

- [ ] **Step 4: Export `sleep` from `packages/worker/src/pipeline.ts`** — change `const sleep = (ms: number, signal: AbortSignal) =>` to `export const sleep = (ms: number, signal: AbortSignal) =>`.

- [ ] **Step 5: Write `packages/worker/src/insightsdb.ts`**

```ts
import type pg from 'pg';
import { buildInsightsTables } from '@arckive/core';

const q = (id: string) => `"${id}"`;

export interface InsightRow {
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  tableName: string;
  lane: string;
  laneP: number | null;
  ruled: boolean;
  protocol: string;
  facts: string[];
  probabilities: Record<string, number> | null;
  sentence: string;
  model: string | null;
}

// An event table the insight loop reads, and for ERC-20-shaped Transfers the
// columns holding from, to and value.
export interface EventSource {
  tableName: string;
  transferColumns: readonly [string, string, string] | null;
}

export interface EventRow {
  tableName: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  transfer: { from: string; to: string; value: bigint } | null;
}

export async function bootstrapInsights(pool: pg.Pool, schema: string, start: bigint): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of buildInsightsTables(schema)) await client.query(s);
    await client.query(
      `INSERT INTO ${q(schema)}._insights_cursor (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
      [start.toString()],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getInsightsCursor(pool: pg.Pool, schema: string): Promise<bigint | null> {
  const r = await pool.query(`SELECT last_block FROM ${q(schema)}._insights_cursor WHERE id = 1`);
  return r.rowCount ? BigInt(r.rows[0].last_block) : null;
}

// The last block of [from, to] that keeps the round at maxRows rows or fewer.
// A single block holding more is taken whole: a round never ends mid-block,
// because the cursor only says which blocks are done.
export async function capRange(
  pool: pg.Pool, schema: string, tables: readonly EventSource[], from: bigint, to: bigint, maxRows: number,
): Promise<bigint> {
  const union = tables
    .map((t) => `SELECT block_number FROM ${q(schema)}.${q(t.tableName)} WHERE block_number BETWEEN $1 AND $2`)
    .join(' UNION ALL ');
  const r = await pool.query(
    `SELECT block_number FROM (${union}) r ORDER BY block_number OFFSET $3 LIMIT 1`,
    [from.toString(), to.toString(), maxRows],
  );
  if (!r.rowCount) return to;
  const cut = BigInt(r.rows[0].block_number);
  return cut > from ? cut - 1n : from;
}

export async function readEventRows(
  pool: pg.Pool, schema: string, tables: readonly EventSource[], from: bigint, to: bigint,
): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for (const t of tables) {
    const c = t.transferColumns;
    const extra = c ? `, ${q(c[0])} AS t_from, ${q(c[1])} AS t_to, ${q(c[2])}::text AS t_value` : '';
    const r = await pool.query(
      `SELECT block_number, tx_hash, log_index${extra} FROM ${q(schema)}.${q(t.tableName)}
       WHERE block_number BETWEEN $1 AND $2`,
      [from.toString(), to.toString()],
    );
    for (const x of r.rows) {
      rows.push({
        tableName: t.tableName,
        blockNumber: BigInt(x.block_number),
        txHash: x.tx_hash,
        logIndex: x.log_index,
        transfer: c ? { from: x.t_from, to: x.t_to, value: BigInt(x.t_value) } : null,
      });
    }
  }
  return rows.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}

// Rows and cursor in one transaction, like commitBatch: a round is either all
// written or not at all. Returns the lanes of the rows actually inserted.
export async function commitInsights(
  pool: pg.Pool, schema: string, rows: InsightRow[], newCursor: bigint,
): Promise<string[]> {
  const client = await pool.connect();
  const inserted: string[] = [];
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO ${q(schema)}._insights
           (block_number, tx_hash, log_index, table_name, lane, lane_p, ruled, protocol,
            facts, probabilities, sentence, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (block_number, tx_hash, log_index) DO NOTHING`,
        [
          r.blockNumber.toString(), r.txHash, r.logIndex, r.tableName, r.lane, r.laneP, r.ruled, r.protocol,
          JSON.stringify(r.facts), r.probabilities ? JSON.stringify(r.probabilities) : null, r.sentence, r.model,
        ],
      );
      if (res.rowCount) inserted.push(r.lane);
    }
    await client.query(
      `UPDATE ${q(schema)}._insights_cursor SET last_block = $1, updated_at = now() WHERE id = 1`,
      [newCursor.toString()],
    );
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 6: Write `packages/worker/src/insights.ts`**

```ts
import type pg from 'pg';
import type { Logger } from 'pino';
import {
  describeEvent, eventColumns, isTransferEvent, planRange, settleLane,
  type CallInfo, type EventDef, type LaneAnswer, type TokenInfo, type TxContext,
} from '@arckive/core';
import { getCursor } from './db.js';
import {
  capRange, commitInsights, getInsightsCursor, readEventRows, type EventSource, type InsightRow,
} from './insightsdb.js';
import { LayaError, type LayaClient } from './laya.js';
import type { Metrics } from './metrics.js';
import { sleep } from './pipeline.js';
import type { ContextSource } from './txcontext.js';

// The insight loop runs behind the ingest cursor, never in front of it and
// never inside it: rows up to _cursor are complete (ingest commits rows and
// cursor together), and nothing here can slow or stop ingest. The model gate
// is shared and rate-limited and has been down for hours at a time; when it
// is, insights fall behind and catch up, and the indexer stays Live.

// One round's rows. Bounded so a dense backfill range is not one giant
// transaction and one huge burst of RPC calls.
export const MAX_ROWS_PER_ROUND = 2000;

export interface InsightTarget extends EventSource {
  contractName: string;
  address: string; // lowercase
  eventName: string;
  token: TokenInfo | null; // ERC-20-shaped Transfer events only
}

export interface CalledContract {
  name: string;
  functions: ReadonlyMap<string, string>; // selector -> function name
}

export type Classifier = Pick<LayaClient, 'classify' | 'identity'>;

export interface InsightsDeps {
  pool: pg.Pool;
  schema: string;
  targets: InsightTarget[];
  called: ReadonlyMap<string, CalledContract>; // indexed contract address -> name + functions
  context: ContextSource;
  classifier: Classifier;
  metrics: Metrics;
  log: Logger;
  batchBlocks: number;
  intervalMs: number;
  wake: { wait(ms: number, signal: AbortSignal): Promise<void> };
}

export class InsightsError extends Error {
  readonly stage: 'model' | 'rpc' | 'db';
  constructor(stage: 'model' | 'rpc' | 'db', options: { cause: unknown }) {
    const cause = options.cause;
    super(`insights ${stage} stage failed: ${cause instanceof Error ? cause.message : String(cause)}`, options);
    this.name = 'InsightsError';
    this.stage = stage;
  }
}

async function at<T>(stage: InsightsError['stage'], work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    throw new InsightsError(stage, { cause });
  }
}

export function insightTargets(defs: EventDef[], tokens: ReadonlyMap<string, TokenInfo>): InsightTarget[] {
  return defs.map((d) => {
    const transfer = isTransferEvent(d);
    const cols = eventColumns(d.event);
    return {
      tableName: d.tableName,
      contractName: d.contractName,
      address: d.address,
      eventName: d.event.name,
      transferColumns: transfer ? ([cols[0]!.name, cols[1]!.name, cols[2]!.name] as const) : null,
      token: transfer ? (tokens.get(d.address) ?? { label: d.contractName, decimals: null }) : null,
    };
  });
}

function callOf(ctx: TxContext | null, called: ReadonlyMap<string, CalledContract>): CallInfo | null {
  const contract = ctx?.to ? called.get(ctx.to) : undefined;
  if (!ctx || !contract) return null;
  return { contract: contract.name, fn: contract.functions.get(ctx.selector) ?? null };
}

export async function runInsightsOnce(deps: InsightsDeps, model: string | null): Promise<boolean> {
  const { pool, schema, metrics } = deps;
  const [done, ingested] = await at('db', Promise.all([getInsightsCursor(pool, schema), getCursor(pool, schema)]));
  if (done === null || ingested === null) throw new Error('no insights cursor — call bootstrapInsights first');
  metrics.insightsBlocksBehind.set(Number(ingested > done ? ingested - done : 0n));
  const range = planRange(done, ingested, deps.batchBlocks);
  if (!range) return false;

  const toBlock = await at('db', capRange(pool, schema, deps.targets, range.fromBlock, range.toBlock, MAX_ROWS_PER_ROUND));
  const rows = await at('db', readEventRows(pool, schema, deps.targets, range.fromBlock, toBlock));
  const contexts = await at('rpc', deps.context.contexts(rows.map((r) => r.txHash)));
  const parties = await at('rpc', deps.context.partyKinds(
    rows.flatMap((r) => (r.transfer && contexts.get(r.txHash) ? [r.transfer.from, r.transfer.to] : [])),
  ));

  const byTable = new Map(deps.targets.map((t) => [t.tableName, t]));
  const described = rows.map((row) => {
    const target = byTable.get(row.tableName)!;
    const ctx = contexts.get(row.txHash) ?? null;
    return {
      row,
      d: describeEvent({
        contractName: target.contractName,
        contractAddress: target.address,
        eventName: target.eventName,
        transfer: row.transfer,
        token: target.token,
        ctx,
        parties,
        call: callOf(ctx, deps.called),
      }),
    };
  });

  const ask = [...new Set(described.filter((x) => !x.d.ruled).map((x) => x.d.sentence))];
  const answers = ask.length ? await at('model', deps.classifier.classify(ask)) : new Map<string, LaneAnswer>();

  const insights: InsightRow[] = described.map(({ row, d }) => {
    const answer = d.ruled ? null : (answers.get(d.sentence) ?? null);
    const { lane, laneP } = settleLane(answer, d.ruled);
    return {
      blockNumber: row.blockNumber, txHash: row.txHash, logIndex: row.logIndex, tableName: row.tableName,
      lane, laneP, ruled: Boolean(d.ruled), protocol: d.protocol, facts: d.facts,
      probabilities: answer?.probabilities ?? null, sentence: d.sentence, model: answer ? model : null,
    };
  });
  const inserted = await at('db', commitInsights(pool, schema, insights, toBlock));

  for (const lane of inserted) metrics.insightsClassified.inc({ lane });
  metrics.insightsBlocksBehind.set(Number(ingested - toBlock));
  deps.log.info(
    { fromBlock: range.fromBlock, toBlock, rows: insights.length, asked: ask.length },
    'insights range processed',
  );
  return true;
}

export async function runInsightsLoop(deps: InsightsDeps, signal: AbortSignal): Promise<void> {
  let model = await deps.classifier.identity();
  let backoffMs = 1000;
  let failing = false;
  while (!signal.aborted) {
    try {
      const progressed = await runInsightsOnce(deps, model);
      if (failing) {
        failing = false;
        model = (await deps.classifier.identity()) ?? model;
        deps.log.info({ model }, 'insights recovered');
      }
      backoffMs = 1000;
      if (!progressed) await deps.wake.wait(deps.intervalMs, signal);
    } catch (err) {
      // Never touches the phase: /healthz and the CR phase describe ingest,
      // and a gate that is down must not take the indexer out of service.
      const stage = err instanceof InsightsError ? err.stage : 'db';
      deps.metrics.insightsErrors.inc({ stage });
      const status = err instanceof InsightsError && err.cause instanceof LayaError ? err.cause.status : undefined;
      deps.log.error(
        { err, stage, ...(status === 401 || status === 403 ? { hint: 'the gate rejected INSIGHTS_HEADER' } : {}) },
        'insights round failed — retrying with backoff',
      );
      failing = true;
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @arckive/worker test -- insights.test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/insights.ts packages/worker/src/insightsdb.ts packages/worker/src/metrics.ts packages/worker/src/pipeline.ts packages/worker/test/insights.test.ts
git commit -m "feat(worker): insight loop behind the ingest cursor"
```

---

### Task 8: Wire it into the worker

**Files:**
- Modify: `packages/worker/src/pipeline.ts` (`onCommitted`, `initialCursor`), `packages/worker/src/insights.ts` (`prepareInsights`), `packages/worker/src/main.ts`
- Test: `packages/worker/test/pipeline.test.ts`, `packages/worker/test/insights.test.ts`

**Interfaces:**
- Produces: `PipelineDeps.onCommitted?: () => void`; `initialCursor(cfg: WorkerConfig): bigint`; `prepareInsights(input: PrepareInsightsInput): Promise<InsightsDeps>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/test/pipeline.test.ts` inside `describe('pipeline', …)`:

```ts
  it('tells onCommitted after each committed range, and only then', async () => {
    let calls = 0;
    const withHook: PipelineDeps = { ...deps, onCommitted: () => calls++ };
    while (await runOnce(withHook)) { /* catch up */ }
    const before = calls;
    await runOnce(withHook); // nothing new
    expect(calls).toBe(before);
    const artifact = loadArtifact();
    const wallet = createWalletClient({ account: privateKeyToAccount(PK), transport: http(anvil.url) }).extend(publicActions);
    const txHash = await wallet.writeContract({
      address: contractAddress, abi: artifact.abi as never, functionName: 'ping', args: [99n], chain: null,
    });
    await wallet.waitForTransactionReceipt({ hash: txHash });
    while (await runOnce(withHook)) { /* catch up */ }
    expect(calls).toBeGreaterThan(before);
  });
```

Append to `packages/worker/test/insights.test.ts` (new `describe`, reusing the file's container setup — place it inside `describe('insights', …)`):

```ts
  it('prepareInsights creates the tables, reads token info and refuses a bad header', async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap(pool, buildControlTables(SCHEMA), defs.map((d) => buildEventTable(SCHEMA, d)));
    const cfg = parseWorkerConfig({
      indexerName: 'ins',
      network: { chainId: 31337, rpc: ['http://127.0.0.1:1'] },
      contracts: [
        { name: 'tok', address: TOKEN, abiInline: [], startBlock: 50 },
        { name: 'vault', address: VAULT, abiInline: [], startBlock: 70 },
      ],
      insights: { laya: { url: 'https://gate.example' } },
    });
    const vaultAbi = [{ type: 'function', name: 'depositFor', inputs: [], outputs: [], stateMutability: 'nonpayable' }];
    const base = {
      cfg, pool, schema: SCHEMA, defs, abis: [[], vaultAbi],
      metrics: createMetrics('prep'), log: pino({ level: 'silent' }), wake: new HeadSignal(),
      context: fakeContext({}), readToken: async () => ({ label: 'TKN', decimals: 6 }),
    };
    await expect(prepareInsights({ ...base, headerLine: 'nonsense secret' })).rejects.toThrow(/INSIGHTS_HEADER/);
    const prepared = await prepareInsights({ ...base, headerLine: 'Authorization: Bearer x' });
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(49n);
    expect(prepared.targets.find((t) => t.tableName === 'tok_transfer')?.token).toEqual({ label: 'TKN', decimals: 6 });
    expect(prepared.called.get(VAULT)?.functions.get(toFunctionSelector('depositFor()'))).toBe('depositFor');
  });
```

Add to that file's imports: `parseWorkerConfig` from `@arckive/core`, `prepareInsights` from `../src/insights.js`, `toFunctionSelector` from `viem`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @arckive/worker test -- pipeline insights.test`
Expected: FAIL — `onCommitted` never called / `prepareInsights` not exported.

- [ ] **Step 3: `packages/worker/src/pipeline.ts`**

Add to `PipelineDeps`:

```ts
  // Called after every committed range; the insight loop waits on it so it
  // follows ingest without polling. The only thing ingest knows about insights.
  onCommitted?: () => void;
```

Replace the cursor computation in `bootstrapIndexer` with a shared helper:

```ts
// startBlock is resolved to a concrete number in main.ts (undefined -> head),
// so the cursor starts just before the earliest contract's first block.
export function initialCursor(cfg: WorkerConfig): bigint {
  const startOf = (c: { startBlock?: number }) => BigInt(c.startBlock ?? 0);
  const minStart = cfg.contracts.reduce(
    (min, c) => (startOf(c) < min ? startOf(c) : min),
    startOf(cfg.contracts[0]!),
  );
  return minStart - 1n;
}

export async function bootstrapIndexer(deps: PipelineDeps): Promise<void> {
  const tables = deps.defs.map((d) => buildEventTable(deps.schema, d));
  await bootstrap(deps.pool, buildControlTables(deps.schema), tables);
  await initCursor(deps.pool, deps.schema, initialCursor(deps.cfg));
}
```

In `runOnce`, right after `end();` (the write-latency timer):

```ts
  deps.onCommitted?.();
```

- [ ] **Step 4: Append `prepareInsights` to `packages/worker/src/insights.ts`**

Add imports: `extractFunctionNames, type WorkerConfig` from `@arckive/core`; `bootstrapInsights` from `./insightsdb.js`; `LayaClient, parseHeaderLine` from `./laya.js` (value import, alongside `LayaError`); `initialCursor` from `./pipeline.js`.

```ts
export interface PrepareInsightsInput {
  cfg: WorkerConfig;
  pool: pg.Pool;
  schema: string;
  defs: EventDef[];
  abis: unknown[]; // full ABIs, in cfg.contracts order
  metrics: Metrics;
  log: Logger;
  wake: InsightsDeps['wake'];
  context: ContextSource;
  readToken: (address: string, fallback: string) => Promise<TokenInfo>;
  headerLine: string | undefined; // INSIGHTS_HEADER
  fetch?: typeof fetch;
}

export async function prepareInsights(input: PrepareInsightsInput): Promise<InsightsDeps> {
  const { cfg, metrics } = input;
  if (!cfg.insights) throw new Error('insights are not configured');
  const header = input.headerLine ? parseHeaderLine(input.headerLine) : null;
  const classifier = new LayaClient(cfg.insights.laya.url, header, {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    onCall: () => metrics.insightsModelCalls.inc(),
    onCacheHits: (n) => metrics.insightsCacheHits.inc(n),
  });

  const tokens = new Map<string, TokenInfo>();
  for (const d of input.defs) {
    if (isTransferEvent(d) && !tokens.has(d.address)) tokens.set(d.address, await input.readToken(d.address, d.contractName));
  }
  const called = new Map<string, CalledContract>(
    cfg.contracts.map((c, i) => [c.address.toLowerCase(), { name: c.name, functions: extractFunctionNames(input.abis[i]) }]),
  );

  await bootstrapInsights(input.pool, input.schema, initialCursor(cfg));
  input.log.info(
    { url: cfg.insights.laya.url, header: header?.name ?? null, tokens: Object.fromEntries(tokens) },
    'insights enabled',
  );
  return {
    pool: input.pool, schema: input.schema, targets: insightTargets(input.defs, tokens), called,
    context: input.context, classifier, metrics, log: input.log,
    batchBlocks: cfg.polling.batchBlocks, intervalMs: cfg.polling.intervalMs, wake: input.wake,
  };
}
```

(The log line names the header, never its value.)

- [ ] **Step 5: `packages/worker/src/main.ts`**

Replace the ABI/defs block with:

```ts
  // Resolve each contract's ABI: mounted file > inline > explorer auto-fetch.
  // Kept whole: insights also read the function names.
  const abis = await Promise.all(cfg.contracts.map((c) => resolveContractAbi(c, cfg.network.explorerApi)));
  const defs: EventDef[] = cfg.contracts.flatMap((c, i) =>
    extractEventDefs(c.name, c.address, abis[i], c.events.length ? c.events : undefined),
  );
```

After `await bootstrapIndexer(deps);`:

```ts
  // Insights (optional) run beside ingest, woken by each committed range.
  const insightsWake = new HeadSignal();
  const insights = cfg.insights
    ? await prepareInsights({
        cfg, pool, schema: deps.schema, defs, abis, metrics, log, wake: insightsWake,
        context: createContextSource(client),
        readToken: (address, fallback) => readTokenInfo(client, address, fallback),
        headerLine: process.env['INSIGHTS_HEADER'],
      })
    : null;
  if (insights) deps.onCommitted = () => insightsWake.notify();
```

Replace `await runLoop(deps, ctrl.signal);` with:

```ts
  await Promise.all([runLoop(deps, ctrl.signal), insights ? runInsightsLoop(insights, ctrl.signal) : null]);
```

Add imports: `prepareInsights, runInsightsLoop` from `./insights.js`; `createContextSource, readTokenInfo` from `./txcontext.js`.

- [ ] **Step 6: Build, lint and run the worker tests**

Run: `pnpm -r build && pnpm lint && pnpm --filter @arckive/worker test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/pipeline.ts packages/worker/src/insights.ts packages/worker/src/main.ts packages/worker/test/pipeline.test.ts packages/worker/test/insights.test.ts
git commit -m "feat(worker): run insights beside ingest when spec.insights is set"
```

---

### Task 9: Docs and live check

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-04-laya-insights-design.md` (stage names, `describeEvent`)

- [ ] **Step 1: README** — add an "Insights (optional)" section after the data paragraph of the Quickstart: what it does (lane, protocol, facts per event; Radar origin), the CR snippet and Secret from the spec, the `_insights` table and a JOIN example, the honest status paragraph (USDC sentences match Radar byte for byte; other contracts unmeasured; audit query `SELECT lane, lane_p, protocol, sentence, tx_hash FROM idx_<name>._insights ORDER BY random() LIMIT 50`), and that ingest never waits on the gate. Add the five `arckive_insights_*` metrics to the Observability list.

- [ ] **Step 2: CLAUDE.md** — under "Key mechanics", add an "Insights" subsection: separate loop behind `_cursor`; never touches `PhaseTracker`; header only via `INSIGHTS_HEADER`; `core/src/insights/signatures.ts` mirrors `radar/radar/signatures.py` and `radar/scripts/export_parity.py` must be re-run when Radar's tables or sentence change; add `insights` to the spec-field chain example; mention `export_parity.py` in Commands.

- [ ] **Step 3: Spec** — replace `stage = model or rpc` with `model, rpc or db`, and `describe(input)` with `describeEvent(input)`.

- [ ] **Step 4: Full verification**

Run: `pnpm lint && pnpm -r build && pnpm -r test && helm lint charts/arckive && scripts/build-install.sh && git diff --exit-code install.yaml`
Expected: all pass, no install.yaml drift.

- [ ] **Step 5: Live check against Arc mainnet and the real gate**

With `docker compose -f docker-compose.dev.yml up -d postgres`, write a scratch config (Arc mainnet chain 5042, `rpc: ["https://rpc.mainnet.arc.io"]`, `finalityTag: latest`, contract `usdc` at `0x3600000000000000000000000000000000000000` with the inline ERC-20 Transfer ABI, no `startBlock`, `insights.laya.url: https://laya-gate.brages.uk`), export `INSIGHTS_HEADER="Authorization: Bearer $RADAR_TOKEN"` from the token file without printing it, run `node packages/worker/dist/main.js` for about three minutes, then `SELECT lane, count(*), round(avg(lane_p)::numeric,3) FROM idx_<name>._insights GROUP BY 1` and a sample of sentences. Expected: rows arrive within seconds of ingest; lanes resemble Radar's wall (mostly swap/payment/bridge). Keep the run short — the gate is shared with two live radars.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-10-04-laya-insights-design.md
git commit -m "docs: Laya insights — README, CLAUDE.md, spec touch-ups"
```
