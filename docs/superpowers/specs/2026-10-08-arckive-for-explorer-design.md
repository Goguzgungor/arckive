# Arckive for the explorer: lanes within seconds, address lookups, operator OOM

Date: 2026-10-08. Status: draft, awaiting review.

Sub-project A2 of the explorer (A: storage layout 2, merged; B: the explorer;
C: cutover; D: natural-language search). Everything here is Arckive code and
must land before the explorer's Indexer is created, because two of the
choices (§4 `insights.startBlock`, §7 `storage.addressIndexes`) are fixed when
a schema is first bootstrapped.

## Why

The explorer replacing radar.arckive.org (sub-project B) shows every USDC
movement and Uniswap v4 event on Arc mainnet as it lands, and its lane
(payment, swap, bridge, …) a few seconds later. Lanes come from the worker's
insight loop. Measured on mainnet in the k3d test cluster (2026-10-07/08) and
read from the code:

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
  Memory grows because the Kubernetes client library opens a new
  connection for every request and keeps it for ten minutes (§6).
- **Lanes would start at block 0.** The insights cursor is bootstrapped at
  the indexer's own start (`initialCursor`). The explorer's Indexer reads the
  whole mainnet history (~25M blocks since 2026-05-15); its insight loop would
  then try to classify all of it — 50M block and receipt reads, most of them
  older than what beamrpc serves without a token. Lanes are wanted from
  launch on only.
- **No ordered lookup by address.** Layout 2 gives each indexed param a
  single-column btree (`usdc_transfer_from_id_idx (from_id)`). It finds an
  address's rows but not its latest ones: "the latest 25 movements of this
  address" — the explorer's address page — reads all of that address's rows
  in every partition and sorts them, and on ~45M rows the busiest addresses
  have millions.

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
5. **The operator stays up.** Three Indexers for ≥ 2 h at the
   chart's 256 Mi limit: no OOMKill; after warm-up the operator's memory does
   not keep growing; reconciles happen on spec changes, on resync and on
   start, not on worker status patches.
6. **Lanes from a chosen block.** An Indexer can start its lanes at a block
   other than its ingest start; the insight loop waits until ingest has
   passed that block.
7. **Address lookups use an index.** With `storage.addressIndexes`, the 25
   latest rows where an address param equals a given address come from an
   index scan in < 50 ms for the busiest address in a table of ≥ 5M rows,
   with every partition's index rebuilt by the compactor like the others.

Goals 1–3 are measured with the in-cluster Laya stub, which answers at once.
With the real gate each cache miss adds the gate's round trip (≤ 1 call/s,
≤ 64 sentences per call, unchanged); the gate is shared with live radars and
is not load-tested.

## Non-goals

Lanes for blocks before their start; running an Arc node; concurrency
inside one endpoint or across endpoints; any change to ingest's RPC path
(`createRpc`, `fetchLogs`, `RangeSizer`); explorer code; Laya client
changes.

## Design

### 1. `Live` means caught up

`runOnce` sets `Backfilling` only when the planned range cannot reach the
head in one round (`range.toBlock < finalized`) or the worker is not `Live`
yet (starting, or recovering from `Degraded`). A `Live` worker whose range
reaches the head stays `Live`, and the commit that reaches the head sets
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

### 4. `spec.insights.rpc` and `spec.insights.startBlock`

Both go through every step of "Adding or changing an Indexer spec field"
(CRD, `IndexerSpecSchema`, `renderWorkerConfig`, `WorkerConfigSchema`, parity
test, `install.yaml`).

**`rpc`:** an optional list of http(s) endpoints for insights only, in
priority order (1–8 entries, no ws: viem's batch scheduler is http's).
Absent, the pool is one endpoint: the last http entry of `network.rpc`, as
`insightsRpc` picks today. URLs may carry API keys, so they are never logged
whole: logs and metrics name an endpoint by its index and host.

**`startBlock`:** the first block that gets lanes. Omitted = the indexer's
own start (today's behaviour); ≥ 0 = that block; negative = that many blocks
before the head **when the insight loop first runs**. The last is the one an
explorer wants, "lanes from launch on": a full-history Indexer backfills for
hours, insights run only once ingest is `Live`, and a head resolved at pod
start would by then be hours old — older than beamrpc serves.

The start becomes the initial insights cursor (`start − 1`), clamped to be
no earlier than the ingest start, and like the ingest cursor it is written
only when the schema's `_insights_cursor` row does not exist yet: it takes
effect once, and later edits change nothing (the CRD description says so).
An absolute or omitted start is written by `bootstrapInsights`, as today. A
negative one is written by the loop's first round, which runs only while
ingest is `Live` and so reads the ingest cursor as the head:
`max(ingest cursor − |n|, ingest start − 1)`, inserted with `ON CONFLICT DO
NOTHING`. Until then `prepareRound` finds no cursor and waits instead of
throwing. While ingest is below an absolute start, `planRange(insights
cursor, ingest cursor)` is empty and the loop waits.

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
  regardless.
- **Waiting on a Secret or ConfigMap.** A reconcile that finds the DSN
  Secret, an ABI ConfigMap or the insights header Secret missing returns
  `waiting` (an invalid spec does not: only a spec change, a new
  generation, fixes it). The generation is kept, so status events still cost
  nothing, and the gate reruns the latest object it has seen for that
  Indexer after 5 s, doubling per consecutive wait up to 60 s. A successful
  reconcile, a `DELETED` event, or a newer event that reconciles anyway (its
  own wait starts the backoff over) ends it. Creating the missing object is
  no event on the Indexer, and manifests are often applied Indexer first —
  the kind e2e applies its Indexer before its Secret and waits 300 s for
  `Live`, as long as the first resync — so without the retry it would wait
  for `RESYNC_INTERVAL_MS`; the resync still covers anything longer.
- **One reconcile per Indexer at a time.** A watch event for an Indexer
  whose reconcile is still running is kept as the one pending rerun (the
  latest object wins) instead of starting a second reconcile beside it.

**The leak.** Read in kubernetes-fluent-client 3.11.7 (ours) and 3.12.4
(latest): every `Get`, `Apply` and `PatchStatus` goes through `k8sCfg`, which
loads the kubeconfig afresh and builds a **new undici `Agent` with
`keepAliveTimeout: 600000`** for that one request, never closed. Each
request therefore leaves a TLS connection open for up to ten minutes. A
reconcile is ~8 requests; at one reconcile per 3.3 s that is ~145 requests a
minute and ~1,450 connections alive at once, each with its socket and TLS
buffers — enough to fill 256 Mi in the ~15 min between the observed
OOMKills. The generation filter alone would cut this ~50×, but connections
would still grow with the number of Indexers and with every resync.

Before the fix, the hypothesis is confirmed without a cluster: a local
HTTPS server and a temporary kubeconfig, N `K8s(kind.ConfigMap).Get()`
calls, N server-side connections. Then the operator gets its own small
Kubernetes client (`operator/src/kubehttp.ts`) for `Get`, server-side
apply, status patch and list: one keep-alive `https.Agent` for the
process, TLS and the server from `@kubernetes/client-node`'s `KubeConfig`
(already in the tree through fluent-client; loaded once, in-cluster or from
a kubeconfig), the auth header fetched per request so a rotated
service-account token is picked up. kubernetes-fluent-client stays for the
watch only — one long-lived connection. Server-side apply keeps
`force=true`, `fieldValidation=Strict` and fluent-client's field manager name
`pepr`. A different name would leave both managers co-owning every field of
the objects applied before the upgrade, and a field later dropped from the
desired state would never be deleted (the other manager still owns it).
Server-side apply shares ownership between managers that apply equal values;
`force` only resolves conflicts. Goal 5 in the real test is the proof.

### 7. `storage.addressIndexes`

An optional boolean (default `false`, today's indexes). When true, every
`address` param `p` of every event table — indexed in the ABI or not — gets
this btree on the partitioned parent, under the name the single-column index
has today, which it replaces:

```sql
CREATE INDEX IF NOT EXISTS "<table>_<p>_id_idx"
  ON "<schema>"."<table>" ("<p>_id", block_number, log_index);
```

Indexed params that are not addresses keep their single-column index.

An index on a partitioned table is created on every existing partition and
on every partition created later, so `Partitions` needs no change, and the
`Compactor`'s `REINDEX TABLE CONCURRENTLY` rebuilds it with the others.
`(block_number, log_index)` after the id lets "latest N for this address"
read each partition's index backwards and page by keyset. The new index
names go through the same 63-byte check as other identifiers
(`NamingError`); today's names are left as they are.

The setting is a new `_meta` key, `address_indexes`, fixed for the schema's
life like `partition_blocks`: turning it on for a schema that already holds
rows would build the indexes inside bootstrap — `CREATE INDEX` on a
partitioned table cannot run `CONCURRENTLY` — and block ingest for as long
as that takes. A different value raises `LayoutError`. A schema bootstrapped
before this change has no such key; bootstrap writes `'false'` for it.

Cost: a composite entry does not deduplicate the way a single-column btree
does (PostgreSQL 13+ keeps one key per run of equal values), so a transfer
row costs roughly 20–50 bytes more than today across `from_id` and `to_id`;
the real test measures it and writes it into this spec. The explorer's
Indexer turns it on.

## Testing

Unit (vitest, no network):

- `RpcPool` against an injected fake transport: chunking (41 calls → 3
  requests, never two in flight), per-call fall-through with each endpoint
  tried at most once per chunk, rest windows (start, doubling, cap, reset),
  resting endpoints skipped and the soonest-ending one used when all rest,
  `ResponseBodyTooLargeError` halving down to one call, `backOffShared()`
  touching only shared endpoints, chain-id drop vs. keep.
- `createContextSource` on a pool: a round of 7 blocks makes one request for
  blocks, one for factories, one for parties; a block failing everywhere
  rejects; a factory failing marks the pool unreadable.
- `runOnce`: a live tail one block behind stays `Live`; a range capped below
  the head sets `Backfilling`.
- Operator: `MODIFIED` with an unchanged generation does not reconcile; a new
  generation does; resync always does; overlapping events for one Indexer run
  one reconcile and one rerun with the latest object; a `waiting` reconcile
  reruns after 5 s, doubling to 60 s, and stops on success, `DELETED` or a
  newer event.
- Operator `kubehttp`, against a local HTTP server: each `KubeApi` method
  sends the right method, path, query and content type; 404 on a get is
  `null`, other errors throw with the status; 50 calls use one connection.
- Core: CRD↔zod parity for both new fields; `renderWorkerConfig` carries
  them; `insights.rpc` refuses ws and more than 8 entries.

Database (testcontainers Postgres, as the existing DB tests):

- `insights.startBlock`: absolute — a fresh schema's insights cursor is
  `startBlock − 1`, clamped to the ingest start, and the loop waits until
  ingest passes it; negative — no cursor until the first `Live` round, which
  writes `ingest cursor − |n|` (clamped); either way a second bootstrap or
  round with a different value leaves an existing cursor alone.
- `storage.addressIndexes`: indexes exist on the parent and on a partition
  created after bootstrap; `EXPLAIN` of `WHERE from_id = $1 ORDER BY
  block_number DESC, log_index DESC LIMIT 25` uses them; a schema created
  with `false` refuses `true` with `LayoutError`, and so does a schema
  without the key; a too-long index name raises `NamingError`.
- Existing anvil-backed insight tests keep passing on a one-endpoint pool.

Real test (k3d, needs the user's go-ahead). It creates the explorer's own
Indexer, which is kept afterwards as the explorer's data: native USDC +
PoolManager from their first blocks, `storage.addressIndexes: true`, the
three insight endpoints above, `insights.startBlock: -2000`, the Laya stub;
plus two testnet Indexers so the operator sees three.

- insights start 2,000 blocks behind once ingest reaches the head → goal 2
  from the insights cursor's progress, goal 6 from it not moving before;
- the following hour, caught up → goal 1 from `insights_blocks_behind`
  sampled every 5 s, goal 3 from `insights_rpc_requests_total`;
- two hours with the operator at 256 Mi → goal 5 from restart count, memory
  every minute and reconcile log lines;
- once `usdc_transfer` holds ≥ 5M rows → goal 7 from `EXPLAIN ANALYZE` on
  the busiest `from_id`, and the bytes per row the indexes add.

The full-history backfill runs on ingest's public endpoint and takes hours;
the insight goals are measured only after ingest reaches the head, because
insights do not run before.

## Docs to update with the change

CLAUDE.md "Insights": the single-endpoint, one-call-at-a-time rule becomes
"one request at a time, up to 20 calls each, over `insights.rpc` or the last
http endpoint of `network.rpc`", plus `insights.startBlock`; "Ingest loop":
the `Live` rule; "Database schema and naming": address indexes and the
`address_indexes` `_meta` key; "Operator reconciliation": the generation
filter and per-Indexer serialization. README: the new spec fields and
metric.

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
