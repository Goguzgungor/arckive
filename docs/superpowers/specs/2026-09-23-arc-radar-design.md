# Arc Radar — design

Date: 2026-09-23
Status: approved in conversation, pending written-spec review

## Goal

A live wall showing every USDC transfer on **Arc mainnet** sorted by what it
is part of — swaps, bridging, DeFi, payments — classified in real time by the
local Laya decision model. It is the Arc counterpart of the existing Stellar
radar (`~/stellar-radar`, radar.sorolog.com): same interaction model (lanes,
viewer questions that re-rank the stream), same UI language.

Success looks like:

- every USDC `Transfer` on Arc mainnet appears on the wall within a few
  seconds of its block;
- lane agreement of **≥ 85 %** on a labelled fixture set of real mainnet
  transfers (the prototype measured 89 %);
- the page shows how much USDC is flowing into each lane right now;
- running it adds no new model instance and no new paid infrastructure.

## Decisions and why

| Decision | Why |
|---|---|
| Read directly from Arc RPC, **not** through Arckive | Running the indexer + Postgres for this page costs more than it is worth. The radar needs a live tail, not a queryable history. |
| Lives in the arclight repo as a top-level `radar/` directory, **Python** | Reuses the Stellar radar's chain-agnostic modules (server, classifier client, gate, sanitize, modelgate, web) whose tuning was measured on live traffic. Rewriting ~1,100 lines in TypeScript buys only language uniformity. `radar/` is outside the pnpm workspace and imports nothing from `packages/`. |
| Shared layad instance and shared `modelgate` / `RADAR_TOKEN` | Laya on the M4 Pro is GPU-bound: four concurrent 256-state batches gave the same ~30 states/s as one. A second process on the same Mac adds isolation, not throughput. Arc demand is small: ~8 transfers/s, but only ~74 distinct shapes per 384 transfers, so ~1–2 new sentences/s reach the model. `modelgate` accepts one token; both apps sit behind the same tunnel on the same host. |
| RPC pool: `rpc.mainnet.arc.io` → `rpc.blockdaemon.mainnet.arc.io` → `rpc.beamrpc.com` | All three answer `eth_getLogs` over 5,000-block ranges. `arc.drpc.org` (free plan) and QuickNode reject ranges above ~100 blocks. The official endpoint rate-limits bursts (HTTP 429 observed), so a fallback pool is required, not optional. |
| Nine lanes, described in the summary's own words | Measured on 384 live transfers: eleven abstractly described lanes scored 4–50 %; nine lanes whose descriptions reuse the exact phrases of the summary sentence scored 89 %. Laya clamps temperature for 11+ options, so keep choice sets ≤ 10. |
| Tail from `now`, no backfill | It is a live wall, not an archive. |

## Architecture

```
Arc RPC pool (priority order, cooldown on failure)
   │  eth_blockNumber (1 s) → eth_getLogs(USDC, Transfer) over new blocks
   ▼
radar/arc.py        feed: group transfers by tx; batch-fetch tx + receipt;
   │                 getCode for counterparties (LRU cache)
   ▼
radar/summarize.py  fact sentence + shape (amount bucket, no addresses);
   │                 display fields (real amount, protocol label, tx link)
   ▼
radar/classify.py   layad /ai/run/batch: lane + control + viewer questions;
   │                 answers cached per shape
   ▼
radar/server.py     queue, batching, stats, per-viewer questions → WebSocket
   ▼
web/index.html      lanes wall
```

### Reused from the Stellar radar (copied, then adapted)

`server.py`, `classify.py`, `gate.py`, `sanitize.py`, `modelgate.py`,
`web/index.html`, `Dockerfile`, `docker-compose.yml`, `scripts/` (tunnel and
launchd plists). Only chain wording, lanes, and stats fields change.

### New, Arc-specific

**`radar/rpc.py` — endpoint pool.** Endpoints from `ARC_RPCS`
(comma-separated; default the three above), tried in configured order. On
HTTP 429, timeout or 5xx the endpoint enters a cooldown starting at 5 s and
doubling to 60 s; the call moves to the next endpoint. A `null` receipt or
transaction is retried on a different endpoint (observed: a lagging node
returns `null` for fresh transactions). Supports JSON-RPC batch requests,
20 calls per batch.

**`radar/arc.py` — feed.**

- Poll `eth_blockNumber` every second. Arc has instant finality, so read up
  to head.
- One `eth_getLogs` for USDC (`0x3600000000000000000000000000000000000000`),
  topic0 `Transfer`, over the new block range.
- For each distinct transaction: `eth_getTransactionByHash` +
  `eth_getTransactionReceipt` (batched). For each counterparty and
  `tx.to`: `eth_getCode`, cached in an LRU (contract-ness does not change in
  practice).
- Cursor starts at head on boot. After an outage the feed resumes from the
  cursor, but a gap older than 5 minutes is dropped silently: the cursor
  jumps to head.
- If a receipt is still unavailable after three endpoints, the transfer is
  emitted without transaction context (it will usually land in *uncertain*).
  The stream never stalls on one transaction.

**`radar/summarize.py` — sentence.**

The model sees only the *shape*:

```
USDC moved from a wallet to a contract, amount 1 to 100 USDC.
In the same transaction: tokens were swapped on an exchange; a fee was taken.
```

- Parties: `a wallet` / `a contract` / zero address → "USDC was minted to …"
  or "USDC was burned from …".
- Amount buckets: `0 USDC`, `less than one cent`, `under 1 USDC`,
  `1 to 100 USDC`, `100 to 10,000 USDC`, `over 10,000 USDC`. Amounts are
  kept (bucketed) because a near-zero value is the dust-spam signal;
  addresses are never in the shape.
- Facts come from a **static signature table** in the repo (function
  selectors and event topic0s → plain facts), derived once from the openchain
  database. No runtime dependency on a signature service. Facts:
  - swap: `Swap` (Uniswap v3 and v4 forms), `Swapped`, `AssetSwapped`,
    selectors such as `exactInputSingle`, `execute` (Universal Router),
    `dagSwapTo` / `uniswapV3SwapTo` (OKX DEX), `swap` (KyberSwap and
    others) → "tokens were swapped on an exchange"
  - bridge: `RelayErc20Deposit`, `FundsMovement`, LI.FI events,
    `depositForBurn` / `DepositForBurn` / `MessageSent` (CCTP) → "funds were
    sent across chains through a bridge"
  - signed: `transferWithAuthorization` / `AuthorizationUsed` → "the payer
    signed an authorization and someone else submitted it"
  - smart account: `handleOps` / `UserOperationEvent` → "it was sent by a
    smart account"
  - fee: `Commission*`, `FeeCollected`, `FeesForwarded` → "a fee was taken"
  - liquidity: `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect`, pool
    `Mint` / `Burn` → "pool liquidity changed"
  - vault: `Deposit`, `Withdrawal` → "tokens were deposited into or withdrawn
    from a contract"
  - lending: `Borrow`, `Repay`, `Supply`, `Liquidat*` → "a loan was opened,
    repaid or liquidated"
  - plain `transfer` call on USDC with no other events → "it was a plain
    direct transfer"
  - none of the above → "nothing else recognisable happened"
- Display fields (never sent to the model): exact amount, protocol label
  from a small address/selector table (OKX DEX, Uniswap, KyberSwap, LI.FI,
  Relay, CCTP, 0x; otherwise "unknown contract"), shortened from → to, and a
  link to `https://explorer.arc.io/tx/<hash>`.
- Token symbols and any other attacker-controlled strings pass through
  `sanitize.py` before they reach either the model or the page.

**Lanes** (`classify.py`), question "What happened in this Arc transaction?":

| Lane | Description given to the model |
|---|---|
| `swap` | tokens were swapped on an exchange |
| `bridge` | funds were sent across chains through a bridge |
| `liquidity` | pool liquidity changed |
| `vault` | tokens were deposited into or withdrawn from a contract |
| `lending` | a loan was opened, repaid or liquidated |
| `signed_payment` | the payer signed an authorization and someone else submitted it |
| `payment` | a plain direct transfer from one wallet to another |
| `issuance` | USDC was minted or burned |
| `spam` | a transfer of less than one cent with nothing else happening |

Plus the existing *uncertain* presentation below the confidence threshold and
the existing control question for saturated states. `lending` is not yet seen
on mainnet; the lane stays so it lights up when a market launches. The
prototype's main residual error is `issuance` attracting unrelated rows; its
wording is the first thing to tune against the eval set.

## UI

Based on the Stellar radar's `web/index.html`: same layout, type, colour
system, viewer question box and "best answers on top" ranking.

- Ten columns (nine lanes + uncertain); on narrow screens they stack as the
  Stellar page does.
- Row: exact amount, protocol label, from → to (shortened), explorer link.
- Header strip: transfers/s, typed/s, sent to model/s, model ms per batch,
  and **USDC volume per lane over the last 10 minutes**.
- Only Arc is named on the page — no references to other chains' products.

## Deploy

- Dokploy on the same server as the Stellar radar (92.4.216.135), app built
  from the arclight repo, branch `main`, build path `radar/`, Dockerfile
  build.
- Env: `LAYA_ENDPOINT=http://172.17.0.1:8919`, `RADAR_TOKEN` (same as the
  Stellar radar), optional `ARC_RPCS`, `RADAR_CANONICAL_HOST`.
- Domain: **radar.arckive.org** (one DNS record; arckive.org is already on
  this Dokploy).
- The Dokploy push webhook is unreliable for this repo, so a GitHub Actions
  job triggers the deploy when `radar/**` changes on `main`, POSTing the
  app's deploy URL (stored as a secret) with a push payload whose `ref` is
  `refs/heads/main` — a bare POST is rejected with "Branch Not Match".

## Error handling

- RPC: priority order with per-endpoint cooldown (5 s → 60 s) on 429 /
  timeout / 5xx; `null` results retried on another endpoint.
- Outage: resume from cursor; gaps older than 5 minutes are dropped silently.
- Model unreachable: rows keep flowing, marked *model offline*; the existing
  failure counter and last-failure message stay.
- Backpressure: bounded queue (2,000); overflow drops the oldest rows and
  increments *dropped*.
- Viewer questions go through `gate.py` as on the Stellar radar.

## Testing

- `radar/tests/` (pytest, runs in CI):
  - `summarize`: fixtures captured from real mainnet receipts — swap, bridge,
    signed payment, mint/burn, plain transfer, unknown contract — each with
    its expected sentence, shape and protocol label.
  - `rpc`: fake transport covering failover on 429, cooldown expiry, batch
    requests, and `null`-receipt retry on another endpoint.
  - `arc` feed: cursor advancement, grouping by transaction, the 5-minute gap
    rule.
- `radar/scripts/eval.py` (manual, needs layad): lane agreement on a labelled
  set of ~400 real transfers stored under `radar/tests/fixtures/`. Bar:
  ≥ 85 %. Run whenever lane wording or the signature table changes. Not in CI
  because CI has no layad.
- CI (`.github/workflows/ci.yml`): a `radar` job running pytest when
  `radar/**` changes; the deploy-trigger job described above.

## Out of scope

- History, search, or any persistence beyond in-memory counters.
- Tokens other than USDC.
- Arckive integration (possible later: index known DEX/bridge contracts'
  own events instead of fetching receipts).
- A second model instance or a hosted model.
