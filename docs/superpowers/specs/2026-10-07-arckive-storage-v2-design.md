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
   measured on mainnet.
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
rename the Indexer to re-index") and the worker reports it as `Degraded`
like any other bootstrap failure. There is no in-place migration: the data is
derived from the chain, rewriting text to bytea on a large table is slower
than re-indexing it, and the API is still `v1alpha1`.

### 2. Event tables

| column | v1 | layout 2 |
|---|---|---|
| `block_number` | bigint | bigint |
| `block_hash` | text | moved to `_blocks` |
| `block_time` | timestamptz | timestamptz |
| `tx_hash` | text | **bytea** |
| `tx_index` | integer | integer |
| `log_index` | integer | integer |
| `contract_address` | text | dropped — one contract per table, kept in `_meta` |
| `_ingested_at` | timestamptz default now() | unchanged (benchmarks read it) |
| `address` params | text | **bytea** |

- Key: `PRIMARY KEY (block_number, log_index)`. `logIndex` is block-scoped in
  the JSON-RPC spec, so the pair identifies a log chain-wide; inserts use
  `ON CONFLICT (block_number, log_index) DO NOTHING`. Verified on mainnet as
  part of the real test.
- Indexes: indexed event parameters keep their btree; `tx_hash` gets a
  **hash** index (equality only, a 4-byte code per row instead of 33 bytes).
- `_meta` records `contract:<table> = <address>` for every event table.
- `_blocks (block_number bigint PRIMARY KEY, block_hash bytea NOT NULL,
  block_time timestamptz NOT NULL)` holds one row per block that produced at
  least one indexed row, written in the same transaction.

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

### 4. Plain SQL

bytea prints as `\x…` (Postgres' default `bytea_output = hex`) and compares
against a `'\x…'` literal through the index:

```sql
SELECT block_time, "from", "to", value
FROM idx_usdc.native_transfer
WHERE "to" = '\x8366a39cc670b4001a1121b8f6a443a643e40951'
ORDER BY block_number DESC LIMIT 20;
```

Each event table also gets a view `<table>_hex` exposing the same columns with
`0x…` text, for dashboards and exports. Filters belong on the base table: a
predicate on the view's text columns cannot use the bytea indexes. The README
says so.

### 5. One statement per table per commit

`commitBatch` groups rows by table and writes each group with one statement:

```sql
INSERT INTO "s"."t" (c1, c2, …)
SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::bytea[], …)
ON CONFLICT (block_number, log_index) DO NOTHING
```

The array cast of each column comes from the DDL type, so the statement has
one parameter per column whatever the row count. `_blocks`, `_dead_letter`
and the cursor update follow the same rule. The transaction stays one per
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
_insights  (block_number bigint, log_index integer, lane text NOT NULL,
            lane_p real, ruled boolean NOT NULL, protocol text,
            facts text[] NOT NULL, sentence_id integer NOT NULL,
            classified_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (block_number, log_index)) PARTITION BY RANGE (block_number)
```

- The model's answer is a function of the sentence and the model, so the
  probabilities live once per `(sentence, model)`; ruled rows use model `''`
  and no probabilities. Sentences are few (Radar caches answers per exact
  sentence for the same reason), so `_sentences` stays small.
- `table_name` and `tx_hash` leave the row: `(block_number, log_index)` joins
  any event table. `protocol` is `NULL` instead of `''`.
- The lane index becomes `(lane, block_number)`, which serves "latest swaps".
- Sentence ids are resolved per round with one `INSERT … ON CONFLICT DO
  NOTHING` plus one `SELECT`, behind a bounded in-process cache.

### 9. Native USDC

Every USDC transfer through the ERC-20 interface is logged twice: by
`0x3600…0000` with 6 decimals and by `0xff…fe` with the same parties and the
value in 18 decimals (Radar's audit; `radar/radar/arc.py:_without_mirrors`).
The native log alone therefore covers every USDC movement once. The explorer
indexes `0xff…fe` Transfer only.

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

## Errors

- `LayoutError` (new, named like the others): v1 schema found.
- `NamingError`: partition or view name over 63 bytes.
- Range-cap errors are absorbed by §7; anything else keeps today's path.

## Testing

- **core:** layout 2 DDL (types, primary key, partition clause, hash index,
  view, `_blocks`), partition naming and limits, bytea values from
  `toSqlValue`, `KNOWN_TOKENS`, the range-cap classifier, CRD rendering of
  `partitionBlocks`.
- **worker (testcontainers + anvil):** an unnest commit is idempotent (a
  replay inserts 0); a batch across a partition boundary creates the
  partition; a v1 schema raises `LayoutError`; `blockTimestamp` is used when
  present and `getBlockTimes` otherwise; a fake client capped at N blocks
  drives the working batch down and back up; insights rows and `_sentences`
  dedupe.
- **operator:** CRD↔zod parity with the new field.
- **e2e (kind):** assertions follow the new columns.
- **Real, on k3d against Arc mainnet:** an Indexer on native USDC and the
  PoolManager, backfilling a historical window and then tailing, writing to
  in-cluster Postgres. Measure bytes per event including the lane, backfill
  blocks/s, live lag and statements per commit; confirm every ERC-20 log in a
  sample has its native twin and that no `(block_number, log_index)` repeats.
  Lanes come from the Mac's Laya model when it is reachable from the cluster.
