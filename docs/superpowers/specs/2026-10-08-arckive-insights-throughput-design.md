# Arckive insights throughput and the operator OOM

Date: 2026-10-08. Status: draft, awaiting review.

## Why

The explorer replacing radar.arckive.org (sub-project B) shows every USDC
movement and Uniswap v4 event on Arc mainnet as it lands, and its lane
(payment, swap, bridge, …) a few seconds later. Lanes come from the worker's
insight loop. Measured on mainnet in the k3d test cluster (2026-10-07):

- **Lanes fall behind and never catch up.** The loop classified ~105 blocks a
  minute against the chain's ~119. Every insight RPC call is sequential behind
  one `Pacer`, one endpoint, ~350–700 ms round trip: `getBlock(full)` +
  `getBlockReceipts` per block, `getCode` per new party, `factory()` per new
  pool. On the shared public endpoint (`rpc.mainnet.arc.io`, per-minute
  quota) a round never completed.
- **Insights pause on every block.** `runOnce` sets the phase to
  `Backfilling` whenever the head moved past the cursor — on a live chain,
  every ~0.5 s block — and back to `Live` after the commit. The insight loop
  runs only while the phase is `Live`, so a large share of its turns is spent
  waiting for the next commit.
- **The operator runs out of memory.** `arckive-operator:v3` was OOMKilled
  10× in 156 min at its 256 Mi limit with three Indexers, reconciling about
  once every 3 s. That cadence is the worker's status loop: each worker
  patches `.status` every 10 s (`startCrStatusLoop`), the patch always
  changes `currentBlock`/`headBlock`, every patch is a watch event, and the
  operator runs a full reconcile (2–3 GETs + 5 server-side applies) for every
  watch event that is not a delete. Three Indexers → one reconcile per 3.3 s.
  Why memory grows by roughly 0.5 MB per reconcile is not known yet.

Arc Radar keeps up with the same chain and the same three public endpoints by
sending JSON-RPC **batches** (20 calls per request) to an endpoint **pool**
that rests an endpoint after a failure (`radar/radar/rpc.py`). This spec
brings that model into the worker.

## Goals

1. **Live lanes within seconds.** At mainnet load, with the insight loop
   caught up, `arckive_insights_blocks_behind` stays ≤ 10 blocks (≈ 5 s) at
   p95 over a one-hour run.
2. **Catch-up.** Behind by ≥ 1,000 blocks, insights advance at ≥ 3× the
   chain's block rate until caught up.
3. **No rate-limit loop.** Over the same hour, fewer than 1% of insight RPC
   requests are answered with a rate limit.
4. **Ingest is untouched.** Insights still run behind `_cursor`, never inside
   ingest, and never send more than one RPC request at a time.
5. **The operator stays up.** Three mainnet Indexers for ≥ 2 h at the
   chart's 256 Mi limit: no OOMKill; after warm-up the operator's memory does
   not keep growing; reconciles happen on spec changes, on resync and on
   start, not on worker status patches.

Goals 1–3 are measured with the in-cluster Laya stub, which answers at once.
With the real gate each cache miss adds the gate's round trip (≤ 1 call/s,
≤ 64 sentences per call, unchanged); the gate is shared with live radars and
is not load-tested.

## Non-goals

Lanes for history older than the indexer; running an Arc node; concurrency
inside one endpoint or across endpoints; any change to ingest's RPC path
(`createRpc`, `fetchLogs`, `RangeSizer`); explorer code; Laya client
changes.

## Design

### 1. `Live` means caught up

`runOnce` sets `Backfilling` only when the planned range cannot reach the
head in one round (`range.toBlock < finalized`). A range that reaches the
head leaves the phase as it is, and the commit that reaches the head sets
`Live` as today. A live tail one block behind therefore stays `Live`; a
worker that starts behind, or falls behind by more than one batch, reports
`Backfilling` until it catches up. `blocks_behind`, `lag` and the status
loop are unchanged.

### 2. The insight RPC pool (`worker/src/rpcpool.ts`)

A new `RpcPool` replaces the single insights client. Its interface:

```ts
type Call<T> = (client: PublicClient) => Promise<T>;
interface RpcPool {
  // Each result in input order: fulfilled, or rejected with the last
  // endpoint's error after every endpoint was tried.
  all<T>(calls: readonly Call<T>[]): Promise<PromiseSettledResult<T>[]>;
  backOffShared(): void; // slows the endpoints ingest also uses
}
```

- **Endpoints** are kept in config order, which is priority, not load
  balancing (as in Radar and in ingest's `rank: false`). Each has a viem
  client on `http(url, { batch: { batchSize: CHUNK }, retryCount: 0,
  timeout: 10_000 })`, its own `Pacer` (`INSIGHTS_RPC_PACE`, now pacing
  requests, not calls) and a rest window.
- **One request at a time.** `all` cuts its calls into chunks of
  `CHUNK = 20` (Radar's). Each chunk is one `pacer.run` on one endpoint:
  inside it the chunk's calls are started in the same tick, which viem's
  batch scheduler sends as one JSON-RPC array, and awaited with
  `Promise.allSettled`. Chunks run one after another; the pool never has two
  requests in flight.
- **Choosing the endpoint.** A chunk goes to the first endpoint in priority
  order that is not resting. If all are resting, to the one whose rest ends
  first: stalling the loop for a minute over a one-second blip costs more
  than one early request.
- **Per-call fall-through.** Calls that failed in a chunk are retried as a
  smaller chunk on the next endpoint, each endpoint at most once per chunk.
  What failed decides what happens to the endpoint:

  | Answer | Endpoint | The call |
  |---|---|---|
  | Rate limit (`isRateLimited`: -32005 or HTTP 429) | rests, its pacer backs off | next endpoint |
  | Transport failure (timeout, connection, HTTP ≥ 500, unparsable body) | rests | next endpoint |
  | `ResponseBodyTooLargeError` | none | the chunk is halved and retried on the same endpoint; a single call that is still too large fails |
  | Any other JSON-RPC error, or `null`/not found | none | next endpoint |

  The last row is how a provider that refuses old blocks (beamrpc:
  "Archive requests require a personal token", -32602) or a node that has
  not seen a block yet costs only those calls a second request, without
  taking the endpoint out of rotation.
- **Rest window:** 5 s after a failure, doubling per consecutive failure to
  60 s, cleared by the next success (Radar's numbers).
- **Ingest failing.** `backOffShared()` backs off the pacers of the pool's
  endpoints that also appear in `network.rpc`. The insight loop calls it
  where it calls `rpcPacer.backOff()` today, while ingest is `Degraded`.
- **Chain id.** At start each endpoint is asked `eth_chainId`. One that
  answers a different chain is dropped with an error log; one that does not
  answer is kept and rests until it does. With no endpoint left, the insight
  loop does not start and logs why; ingest runs on.

### 3. Context reads on the pool (`txcontext.ts`)

`createContextSource` takes the pool instead of a client and a pacer:

- **Blocks.** One `pool.all` per round with `getBlock({ includeTransactions:
  true })` and `getBlockReceipts` for every block holding a row — 2 calls per
  block, 10 blocks per request. A block whose block or receipts call failed
  everywhere rejects `contexts()` (the round fails at stage `rpc` and is
  retried with backoff, as today).
- **Pools' `factory()`** for every new pool in the round: one `pool.all`.
  A failed call marks the pool unreadable for 10 min, as today.
- **Party kinds:** one `pool.all` of `getCode` for every new non-sender
  party; a failure rejects `partyKinds()`, as today.

Caches, `isContractCode`, the sender-is-a-wallet rule and the
`TxContext` shape are unchanged. `readTokenInfo` (start-up only) stays on
ingest's client.

### 4. `spec.insights.rpc`

An optional list of http(s) endpoints for insights only, in priority order
(1–8 entries, no ws: viem's batch scheduler is http's). Absent, the pool is
one endpoint: the last http entry of `network.rpc`, as `insightsRpc` picks
today. It goes through every step of "Adding or changing an Indexer spec
field" (CRD, `IndexerSpecSchema`, `renderWorkerConfig`, `WorkerConfigSchema`,
parity test, `install.yaml`). URLs may carry API keys, so they are never
logged whole: logs and metrics name an endpoint by its index and host.

The explorer's Indexer will use `rpc.blockdaemon.mainnet.arc.io`,
`rpc.beamrpc.com`, `rpc.mainnet.arc.io` for insights (live blocks are
recent, which the first two serve) and leave the public endpoint first for
ingest's full-history `getLogs`.

### 5. Metric

`arckive_insights_rpc_requests_total{endpoint, outcome}` — one count per
HTTP request the pool sends; `endpoint` is the index in the pool, `outcome`
is `ok`, `rate_limited` or `failed` (any call in the request). Goal 3 reads
from it. README's metric list gains it.

### 6. Operator: reconcile on change, one at a time

Findings so far are in **Why**. Two changes are needed whatever the leak
turns out to be, because a status patch every 10 s per Indexer should not
cost a reconcile at all:

- **Generation filter.** The watch callback reconciles an `ADDED` event, and
  a `MODIFIED` event only when `metadata.generation` differs from the last
  generation the operator reconciled for that uid (status writes do not bump
  `generation` on a CRD with the status subresource). A `DELETED` event
  drops the uid from the map. The periodic resync reconciles every Indexer
  regardless, so Secrets and ConfigMaps created after their Indexer are
  still picked up within `RESYNC_INTERVAL_MS`, as today.
- **One reconcile per Indexer at a time.** A watch event for an Indexer
  whose reconcile is still running is kept as the one pending rerun (the
  latest object wins) instead of starting a second reconcile beside it.

**The leak itself** is root-caused before it is fixed
(superpowers:systematic-debugging): run the operator with
`--heapsnapshot-signal`, take heap snapshots after warm-up and after a few
hundred reconciles against a real API server, and find what retains memory
per reconcile. Candidates to check first: per-request HTTP agents or
dispatchers in kubernetes-fluent-client's `Apply`/`Get`, and the watch's
internal state. The fix follows the evidence; if the leak is in the
library, the fix is a version change or reusing one client, not a
workaround in our code. This needs a cluster: the k3d `arckive` cluster is
stopped and is restarted only with the user's go-ahead.

## Testing

Unit (vitest, no network):

- `RpcPool` against an injected fake transport: chunking (41 calls → 3
  requests, never two in flight), per-call fall-through with each endpoint
  tried at most once per chunk, rest windows (start, doubling, cap, reset),
  resting endpoints skipped and the soonest-ending one used when all rest,
  `ResponseBodyTooLargeError` halving down to one call, `backOff('ingest')`
  touching only shared endpoints, chain-id drop vs. keep.
- `createContextSource` on a pool: a round of 7 blocks makes one request for
  blocks, one for factories, one for parties; a block failing everywhere
  rejects; a factory failing marks the pool unreadable.
- `runOnce`: a live tail one block behind stays `Live`; a range capped below
  the head sets `Backfilling`.
- Operator: `MODIFIED` with an unchanged generation does not reconcile; a new
  generation does; resync always does; overlapping events for one Indexer run
  one reconcile and one rerun with the latest object.
- Existing anvil-backed insight tests keep passing on a one-endpoint pool.

Real test (k3d, needs the user's go-ahead): the mainnet explorer Indexer
(native USDC + PoolManager) with the three insight endpoints above and the
Laya stub, plus two testnet Indexers so the operator sees three:

- one hour caught up → goal 1 from `insights_blocks_behind` sampled every
  5 s, goal 3 from `insights_rpc_requests_total`;
- insights held back ≥ 1,000 blocks (start the worker with insights disabled,
  then enable) → goal 2 from the cursor's progress;
- two hours with the operator at 256 Mi → goal 5 from restart count, memory
  every minute and reconcile log lines.

## Docs to update with the change

CLAUDE.md "Insights": the single-endpoint, one-call-at-a-time rule becomes
"one request at a time, up to 20 calls each, over `insights.rpc` or the last
http endpoint of `network.rpc`"; "Ingest loop": the `Live` rule;
"Operator reconciliation": the generation filter and per-Indexer
serialization. README: the new spec field and metric.

## Risks

- The public endpoint's quota may count calls, not requests. Then batching
  shortens rounds but does not stretch the quota; the pool's rests move load
  to the other two endpoints, and goal 3 shows whether that is enough.
- Batches make each failure wider: one 429 fails 20 calls. Per-call
  fall-through retries them elsewhere at once, so a round fails only when
  every endpoint refused.
- With the generation filter, a Deployment deleted by hand comes back at the
  next resync (≤ 5 min), not on the next status patch. That was only ever an
  accident of the storm.
