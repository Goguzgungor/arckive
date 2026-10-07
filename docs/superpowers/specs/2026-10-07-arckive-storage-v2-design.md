# Arckive storage layout 2 — compact, partitioned, batched

Date: 2026-10-07. Status: approved for implementation.

## Why

radar.arckive.org becomes an Etherscan-style explorer of what Arckive
indexes on Arc mainnet: every USDC movement and the Uniswap v4 PoolManager,
with their whole history, lanes from Laya beside them. The data lives in a
managed Postgres (Supabase, Frankfurt); the workers run on a Mac in k3d. That
setting exposed four limits of the current storage and write path, all
measured on 2026-10-07:

- **Size.** A v1 USDC transfer row costs 510 bytes with its three indexes
  (testnet DB, 7,115 rows). About 260 of its 332 tuple bytes are hex text:
  `tx_hash`, `block_hash`, `from`, `to` and `contract_address`, which is the
  same in every row. `_insights` adds a second row per event carrying
  `facts` jsonb, `probabilities` jsonb and the sentence text. Arc mainnet logs
  ~20 USDC transfers/s on average (9–51/s across five windows in one hour),
  ~1.7M rows/day.
- **Round trips.** `commitBatch` sends one `INSERT` per row. At ~40 ms to a
  Frankfurt database the average load already fills ~80% of each second with
  round trips; 50/s bursts fall behind.
- **Range caps.** drpc's free plan now refuses `eth_getLogs` over 101 blocks
  ("ranges over 10000 blocks are not supported" — the message is wrong). The
  default `batchBlocks: 1000` left both testnet demo indexers in a 30 s backoff
  loop until the CR was patched by hand.
- **Backfill.** Every block with logs costs a `getBlock` for its timestamp. A
  full mainnet history is ~24.7M blocks; Arc's `eth_getLogs` already returns
  `blockTimestamp` on every log.

## Goals

1. An indexed event with its lane costs at most ~450 bytes (v1: ~1.1–1.4 KB),
   measured on mainnet; after the revision in §2/§8/§11, about 325 bytes measured (toward ~315 as dictionaries amortise).
2. A commit sends a fixed number of statements, independent of its row count.
3. Backfill makes no per-block call when the node returns `blockTimestamp`,
   and survives provider range caps without manual tuning.
4. Native USDC (`0xff…fe`) is indexable as a contract, with correct token info.
5. Plain SQL keeps working without helper code.

## Non-goals

The explorer UI, deployment (Supabase, mainnet k3d, Dokploy, tunnel),
natural-language search, lanes for history older than the indexer, running an
Arc node, and migrating existing v1 schemas in place.

## Design

### 1. Layout version, clean break

`_meta` gains the row `layout = '2'`, written at bootstrap. A schema that
already has a `_cursor` but no `layout = '2'` row is a v1 schema: bootstrap
raises `LayoutError` ("schema idx_x uses storage layout 1; drop the schema or
rename the Indexer to re-index") and the worker exits with it, like any
other bootstrap failure (the pod's log and CrashLoopBackOff show it). There is no in-place migration: the data is
derived from the chain, rewriting text to bytea on a large table is slower
than re-indexing it, and the API is still `v1alpha1`.

### 2. Event tables

| column | v1 | layout 2 |
|---|---|---|
| `block_number` | bigint | bigint |
| `block_hash` | text | moved to `_blocks` |
| `block_time` | timestamptz | moved to `_blocks` |
| `tx_hash` | text | **bytea** |
| `tx_index` | integer | dropped — `log_index` already orders a block's logs |
| `log_index` | integer | integer |
| `contract_address` | text | dropped — one contract per table, kept in `_meta` |
| `_ingested_at` | timestamptz default now() | moved to `_blocks` (benchmarks read it there) |
| `address` params | text | **`<param>_id integer`** → `_addresses.id` (§11) |

Revised after the first mainnet measurement (2026-10-07): `block_time`,
`_ingested_at` and `tx_index` are the same for every row of a block (or
redundant), so they cost 28 bytes per row in the event table for nothing a
join to `_blocks` cannot give back; addresses repeat heavily (14,819 distinct
addresses in 170,045 transfers), so they are stored once (§11).

- Key: `PRIMARY KEY (block_number, log_index)`. `logIndex` is block-scoped in
  the JSON-RPC spec, so the pair identifies a log chain-wide; inserts use
  `ON CONFLICT (block_number, log_index) DO NOTHING`. Verified on mainnet as
  part of the real test.
- Indexes: indexed event parameters keep their btree (on the id column for
  addresses); `tx_hash` gets a **btree**. A hash index was the first choice,
  but measured on 170,045 mainnet rows it cost 31.8 bytes per row freshly
  built and 36.2 after incremental inserts, against 29.1 for a btree (which
  deduplicates the ~2.6 rows each transaction has).
- `_meta` records `contract:<table> = <address>` for every event table.
- `_blocks (block_number bigint PRIMARY KEY, block_hash bytea NOT NULL,
  block_time timestamptz NOT NULL, _ingested_at timestamptz NOT NULL DEFAULT
  now())` holds one row per block that produced at least one indexed row,
  written in the same transaction. Freshness is `_ingested_at − block_time`
  per block.

### 3. Partitioning

Event tables, `_insights` and `_blocks` are `PARTITION BY RANGE
(block_number)`. Partition `n` covers `[n·P, (n+1)·P)` and is named
`<table>_p<n>`; `P` is `spec.storage.partitionBlocks` (default 2,000,000 ≈ 11.6
days of Arc blocks; minimum 10,000). A partition name over 63 bytes raises
`NamingError` at bootstrap. Before each commit the worker creates any missing
partition the batch touches (`CREATE TABLE IF NOT EXISTS … PARTITION OF …`)
inside the same transaction, remembering which ones exist so the steady state
sends nothing extra. Partitions make vacuum and index builds per-range, and a
retention window, if one is ever wanted, a `DROP TABLE`.

Indexes built row by row are looser than freshly built ones (measured: the
`from`/`to` indexes 26 → 20 bytes per row, `tx_hash` 36 → 32 when rebuilt).
A partition is rebuilt when ingest moves past it for that table (a table
with no rows in a partition has nothing to rebuild, and the partition does not
exist), so the worker rebuilds that partition's indexes
once with `REINDEX TABLE CONCURRENTLY` — outside any transaction, in the
background, one at a time, never blocking ingest; a failure is logged at warn
and not retried (the partition stays correct, only looser). A restart does not
revisit partitions finished before it.

### 4. Plain SQL

bytea prints as `\x…` (Postgres' default `bytea_output = hex`) and compares
against a `'\x…'` literal through the index:

Each event table gets a view `<table>_hex` — the readable form of the table:
`block_time` and `_ingested_at` from `_blocks`, every address resolved from
`_addresses` under its parameter name, hashes and addresses as `0x…` text. It
is what dashboards and exports read. Filters belong on the base table, where
an address is matched through its id:

```sql
SELECT b.block_time, t.*
FROM idx_usdc.usdc_transfer t JOIN idx_usdc._blocks b USING (block_number)
WHERE t.to_id = (SELECT id FROM idx_usdc._addresses
                 WHERE address = '\x8366a39cc670b4001a1121b8f6a443a643e40951')
ORDER BY t.block_number DESC LIMIT 20;
```

A predicate on the view's text columns cannot use the indexes. The README says
so.

### 5. One statement per table per commit

`commitBatch` groups rows by table and writes each group with one statement:

```sql
INSERT INTO "s"."t" (c1, c2, …)
SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::bytea[], …)
ON CONFLICT (block_number, log_index) DO NOTHING
```

The array cast of each column comes from the DDL type, so the statement has
one parameter per column whatever the row count. `_blocks`, `_dead_letter`
and the cursor update follow the same rule, and so do the batch's addresses
(§11): one insert of the new ones, one select of all their ids, before the
event rows. A commit to one table is therefore BEGIN, two address
statements, `_blocks`, the table, the cursor, COMMIT. The transaction stays one per
range, as today. The insight loop writes `_sentences` and `_insights` the same
way.

### 6. Block time from the log

When every log in a `getLogs` answer carries `blockTimestamp`, the pipeline
takes block times from it and calls nothing else; otherwise it falls back to
`getBlockTimes` (and the newHeads cache) exactly as today. Block hashes for
`_blocks` come from the logs in both cases. If viem's `getLogs` drops the
field, the worker issues `eth_getLogs` through `client.request` and formats
the logs itself.

### 7. Adaptive range

A `getLogs` error whose message reads as a range or result cap (`range`,
`ranges over`, `too many`, `more than`, `response size`, `limit`, but not
`rate limit`) halves the pipeline's working batch (floor 1) and retries at
once, without `Degraded` or backoff. Every 20 consecutive successful ranges
double it again, up to `polling.batchBlocks`. Rate limits keep today's
backoff. Each change is logged once at `warn` with the old and new size. The
working batch lives in memory: a restart starts again from `batchBlocks` and
finds the cap in a few calls.

### 8. Insights

```
_sentences (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            sentence text NOT NULL, model text NOT NULL DEFAULT '',
            probabilities jsonb, UNIQUE (sentence, model))
_labels    (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            lane text NOT NULL, lane_p real, ruled boolean NOT NULL,
            protocol text, facts text[] NOT NULL, sentence_id integer NOT NULL,
            UNIQUE NULLS NOT DISTINCT (lane, lane_p, ruled, protocol, facts, sentence_id))
_insights  (block_number bigint, log_index integer, lane text NOT NULL,
            label_id integer NOT NULL,
            PRIMARY KEY (block_number, log_index)) PARTITION BY RANGE (block_number)
```

- Revised after the first mainnet measurement: 108,981 lane rows carried only
  517 distinct (lane, lane_p, ruled, protocol, facts, sentence) tuples, and
  `facts text[]` alone cost 33 bytes per row. Each tuple is stored once in
  `_labels`; a row keeps its key, its lane (so `(lane, block_number)` still
  serves "latest swaps" from the index) and a label id. `classified_at` is
  dropped: lane lag is `_cursor − _insights_cursor` and the
  `insights_blocks_behind` metric. `UNIQUE NULLS NOT DISTINCT` needs
  PostgreSQL 15 or later.
- Label ids are resolved per round like sentence ids: an insert of only the
  tuples that do not exist yet (`INSERT … SELECT … WHERE NOT EXISTS … ON
  CONFLICT DO NOTHING`) plus one `SELECT`, with no probabilities update.
  Dictionary inserts send only rows that do not exist yet (§11).

- The model's answer is a function of the sentence and the model, so the
  probabilities live once per `(sentence, model)`; ruled rows use model `''`
  and no probabilities. Sentences are few (Radar caches answers per exact
  sentence for the same reason), so `_sentences` stays small.
- `table_name` and `tx_hash` leave the row: `(block_number, log_index)` joins
  any event table. `protocol` is `NULL` instead of `''`.
- The lane index becomes `(lane, block_number)`, which serves "latest swaps".
- Sentence ids are resolved per round by inserting only new (sentence, model)
  pairs (`INSERT … SELECT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING`), a
  separate `UPDATE` that fills probabilities still NULL, then one `SELECT`.
- A view `_insights_full` joins each row with its label and sentence —
  lane, lane_p, ruled, protocol, facts, sentence, model (`NULL` for `''`) and
  probabilities — for plain SQL.
- `facts` cannot travel through `unnest` as an array of arrays (unnest
  flattens them), so each row's facts are sent as one comma-joined string
  and split in SQL; fact names never contain commas.

### 9. Native USDC

Every USDC ERC-20 transfer that moves value is logged twice: by
`0x3600…0000` with 6 decimals and by `0xff…fe` with the same parties and the
value in 18 decimals (Radar's audit; `radar/radar/arc.py:_without_mirrors`).
The native log alone therefore covers every USDC value movement once.
Zero-value ERC-20 transfers (often address-poisoning spam) and ERC-20
self-transfers move no USDC, so no native log is written for them; the explorer
indexes `0xff…fe` Transfer only and does not see them (index `0x3600…0000` too
if they must appear).

`0xff…fe` has no `symbol()` or `decimals()`, so core gets `KNOWN_TOKENS`
keyed by chainId: `0xff…fe` is `USDC` with 18 decimals on Arc mainnet (5042)
and testnet (5042002). Token-info lookup consults it before calling the chain.
A mainnet example `manifests/arc-mainnet/k8s/explorer.yaml` indexes native
USDC Transfer and the PoolManager's events.

### 10. CRD and config

`spec.storage.partitionBlocks` (integer, minimum 10,000, default 2,000,000) is
added through the usual chain: CRD → `IndexerSpecSchema` →
`renderWorkerConfig` → `WorkerConfigSchema`, parity test, `install.yaml`. Nothing
else in the operator changes.

### 11. Addresses

```
_addresses (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            address bytea NOT NULL UNIQUE)
```

Every `address` event parameter is stored as `<param>_id integer` (a column
named `from` becomes `from_id`; a parameter whose `_id` name collides with
another column raises `DdlError` at bootstrap like any collision). The writer
collects the batch's distinct addresses, inserts the new ones (`ON CONFLICT
DO NOTHING`), selects all their ids, and substitutes them before the event
insert — inside the same transaction, so an id never points at an address
that was rolled back. `_addresses` is not partitioned: it grows with distinct
addresses, not with rows (14,819 for 170,045 transfers).

Dictionary inserts (`_addresses`, `_sentences`, `_labels`) send only rows that
do not exist yet, because PostgreSQL consumes an identity value for every row
an INSERT tries even when `ON CONFLICT` skips it (measured: before the fix, 5
commits of the same 2 addresses gave the next address id 12 instead of 3). Readers of addresses
(the insight loop's `readEventRows`, the `_hex` views) join it.

## Errors

- `LayoutError` (new, named like the others): v1 schema found.
- `NamingError`: partition or view name over 63 bytes.
- Range-cap errors are absorbed by §7; anything else keeps today's path.

## Testing

- **core:** layout 2 DDL (types, primary key, partition clause, btree on
  `tx_hash`, `<param>_id` columns for addresses, the `_hex` view's joins,
  `_blocks` with `block_time`/`_ingested_at`, `_addresses`, `_labels`),
  partition naming and limits, bytea values from `toSqlValue`, `KNOWN_TOKENS`,
  the range-cap classifier, CRD rendering of `partitionBlocks`.
- **worker (testcontainers + anvil):** an unnest commit is idempotent (a
  replay inserts 0); a commit sends a fixed number of statements whatever its
  row count (BEGIN, two address statements, `_blocks`, the table, cursor,
  COMMIT); addresses are stored once and the same address keeps its id
  across commits; a rolled-back batch leaves no address or partition believed
  to exist; a batch across a partition boundary creates the partition and the
  finished partition's indexes are rebuilt once; a v1 schema raises
  `LayoutError`; `blockTimestamp` is used when present and `getBlockTimes`
  otherwise; a fake client capped at N blocks drives the working batch down
  and back up; insights rows, `_labels` and `_sentences` dedupe.
- **operator:** CRD↔zod parity with the new field.
- **e2e (kind):** assertions follow the new columns.
- **Real, on k3d against Arc mainnet:** an Indexer on native USDC and the
  PoolManager, backfilling a historical window and then tailing, writing to
  in-cluster Postgres. Measure bytes per event including the lane, backfill
  blocks/s, live lag and statements per commit; measure how many ERC-20 logs
  in a sample have a native twin; compare row counts and values with layout 1
  on the same block window.
## Measured

### First layout 2 (before the revision)

Arc mainnet, k3d, 2026-10-07.

- Same block window (24,745,323–24,752,500) indexed by v1 and v2: 81,725 USDC
  rows and 12,936 swaps in both, equal value sums, 0 row-by-row mismatches
  (tx_hash, from, value, block_time) — block times from `blockTimestamp` equal
  `getBlock` times.
- Bytes per row including indexes, v1 → v2: usdc_transfer 490 → 269 (v2
  includes the tx_hash hash index v1 lacked); poolmanager_swap 546 → 337;
  _insights 679 → 166; _sentences 142 rows (160 kB) for 3,997 lane rows;
  _blocks 109 B per block (~9 B per transfer). A USDC event with its lane:
  ~1,170 B → ~445 B.
- Backfill: ~5,700 blocks (~60k rows) in ~20 s, no per-block getBlock.
- Adaptive span: batchBlocks 5000 met "query exceeds max results 20000, retry
  with the range …", shrank 5000→2500→1250→625 and grew back to 5000 with no
  Degraded.
- Twins: 2,689/2,700 ERC-20 USDC logs have a native twin; the 11 without are 7
  zero-value and 4 self-transfers.
- Insights (unchanged by this work): sequential RPC at ~350–700 ms round trips
  keeps lanes near ingest's row rate (~1,035 vs ~1,027 rows/min) but behind
  the chain in blocks (105 vs 119 blocks/min); a backfilled backlog does not
  shrink.

### Dense layout 2 (after the revision), Arc mainnet, k3d, 2026-10-07

- Same block window (24,745,323–24,752,500) as layout 1: 81,725 USDC rows with
  equal value sums and 12,936 swaps; row-by-row comparison through
  `usdc_transfer_hex` / `poolmanager_swap_hex` (tx_hash, from, to, value,
  block_time; swaps: sender, amount0, id, block_time): 0 mismatches.
- Bytes per row including indexes: usdc_transfer 189 (heap 96, indexes 93,
  tuple 88); poolmanager_swap 316; _blocks 118 per block (~12 per transfer);
  _insights 124 (heap 67, indexes 57, tuple 52); _addresses 21,735 rows in
  2.95 MB for 212,063 transfers; _labels 182 and _sentences 126 rows (280 kB
  together) for 3,312 lane rows. Every dictionary's max(id) equals its row
  count — no burned identity values.
- A USDC event with its lane: ~1,170 B (layout 1) → ~445 B (first layout 2) →
  ~325 B (dense), falling toward ~315 B as the dictionaries amortise.
- Provider limits met on the way: viem rejected a 500-block getLogs answer over
  10 MiB (ResponseBodyTooLargeError) — now a span cap (500 → 250 → 125 and
  back); rpc.beamrpc.com (Allnodes publicnode) refuses blocks older than about
  two hours without a personal token ("Archive requests require a personal
  token"), and viem's fallback stops on that -32602; the public RPC's
  per-minute quota (LimitExceeded "rate limit exceeded") keeps insights from
  completing a round when ingest shares the endpoint.
