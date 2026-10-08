# Arckive Explorer — a live, Etherscan-grade view of what Arckive indexes on Arc

Date: 2026-10-08. Status: approved.

Sub-project B. A (storage layout 2, PR #26) and A2
(`2026-10-08-arckive-for-explorer-design.md`, PR #27: lanes within seconds,
`insights.startBlock`, `storage.addressIndexes`, operator OOM) are merged.
C moves `radar.arckive.org` to this app and retires the Dokploy `radar`
service. D adds natural-language search.

## What and why

radar.arckive.org is Arc Radar: a live wall of every USDC transfer on Arc
mainnet, each filed under a lane (payment, swap, bridge, …) by the Laya
model. It reads the chain directly and keeps nothing. The explorer replaces
it with a product built on Arckive's own data: the same fast-moving tape on
the home page, and behind every row a transaction page and an address page
with the whole history since mainnet began (2026-05-15). It shows **only**
what Arckive indexes — native USDC (`0xff…fe`) Transfer logs and the Uniswap
v4 PoolManager (`0x8366…0951`) — and should feel like a premium Etherscan
for that slice of Arc.

Decisions made with the user (2026-10-07/08):

- Home is the live tape. Its speed — every movement, as it lands — does not
  change; the design does.
- Clicking a row or searching a transaction hash opens the transaction page;
  an address page exists too. Search takes a tx hash or an address.
- Visual direction **C · Broadsheet**: light paper, a serif headline written
  from live numbers, "the tape". Mockups:
  `2026-10-08-arckive-explorer-mockups/{home,tx,address}.{png,html}` (lanes
  in them are illustrative; the test cluster ran a Laya stub).
- Lanes arrive within seconds (A2).
- A separate Next.js app next to the database on the Mac's k3d, served through
  a Cloudflare tunnel. One server-side database tailer fans out to every
  viewer over Server-Sent Events.
- History: everything since 2026-05-15, never deleted. Transfers and pool
  events are backfilled; lanes start at launch.
- Pure PostgreSQL, no extensions.

## Scope of v1

**In:** home (live tape, headline, largest this minute, lanes share),
transaction page, address page with full-history totals and paged history,
search, the explorer's Indexer and database on k3d, a preview hostname
through the tunnel.

**Out:** DNS cutover and Radar's retirement (C); natural-language search
(D); blocks, tokens, pools or charts as pages of their own; accounts, API
keys, a public API; dark mode; other chains; the ERC-20 face of USDC
(`0x3600…0000`) — its logs mirror the native ones except zero-value
"address poisoning" transfers and self-transfers (11 of 2,700 measured),
which v1 does not show; lanes for anything before launch.

## Architecture

```
Arc RPCs ──▶ worker (Indexer arc-explorer) ──▶ Postgres 17 (k3d, PVC)
                 └─ insights ─▶ Laya gate        ▲            ▲
                                                 │ read-only  │ explorer schema
                                         explorer (Next.js standalone)
                                           ├─ tailer ─▶ SSE fan-out ─┐
                                           ├─ rollup job             │
                                           └─ SSR pages ─────────────┤
                                                                     ▼
                                           cloudflared ──▶ viewers' browsers
```

- **`packages/explorer`**, a pnpm workspace package: Next.js 15 (App Router,
  React 19, `output: 'standalone'`), TypeScript ESM like the rest of the repo,
  `pg` for the database, no ORM, no CSS framework. It depends on
  `@arckive/core` only for pure helpers (`LANES`, `NATIVE_USDC`, naming);
  core stays free of web code. A new `Dockerfile` target `explorer` builds
  the image. `pnpm -r build/test` and CI cover it like the other packages.
- **One process** serves pages, the SSE stream and the background jobs (the
  tailer and the rollup job start once per process, from
  `instrumentation.ts`). One replica: the tailer is cheap and fan-out to a
  few thousand SSE connections fits one Node process. Two replicas would
  each tail the database; the rollup job takes a Postgres advisory lock so
  only one of them ever writes.
- **Database access.** The worker owns `idx_arc_explorer`. The explorer
  connects as its own role, `explorer`, with `USAGE` + `SELECT` on that
  schema (granted on the partitioned parents and views, which is all a query
  through them needs) and ownership of a schema of its own, `explorer`. The
  database already runs (`manifests/arc-mainnet/k8s/postgres.yaml`, created
  in A2's real test), so the role comes from a SQL file applied once by hand
  with `psql` (`manifests/arc-mainnet/k8s/explorer-role.sql`, idempotent):
  it creates the role, grants `USAGE`/`SELECT` on `idx_arc_explorer` and its
  existing tables and views, and sets the worker role's default privileges
  (`ALTER DEFAULT PRIVILEGES FOR ROLE arckive IN SCHEMA idx_arc_explorer
  GRANT SELECT ON TABLES TO explorer`) for tables the worker adds later.
  `statement_timeout` 5 s for the role; a pool of 10 connections.
- **Configuration** (env, read with bracket notation, validated with zod at
  start): `DATABASE_URL`, `ARCKIVE_SCHEMA` (`idx_arc_explorer`),
  `USDC_TABLE` (`usdc_transfer`), `POOL_TABLE_PREFIX` (`poolmanager_`),
  `ARC_RPC` (token metadata reads), `LANE_HOLD_MS` (8000),
  `MAX_STREAMS` (2000), `PORT`. At start the explorer checks that the tables
  and columns it reads exist and stops with a clear error otherwise.

## The explorer's Indexer

`manifests/arc-mainnet/k8s/explorer.yaml`, created during A2's real test
and running since (its backfill on the public endpoint's quota takes many
hours):

- `usdc`: `0xfffffffffffffffffffffffffffffffffffffffe`, `Transfer`,
  `startBlock: 0`.
- `poolmanager`: PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`,
  `Initialize`, `ModifyLiquidity`, `Swap`, `Donate`, `startBlock: 0` (one
  `getLogs` covers both contracts, so a later start saves nothing).
- `network.rpc`: `https://rpc.mainnet.arc.io` only (full history,
  2,000-block `getLogs`; a range-capped second endpoint slows the shared
  span, A2 Measured); `storage.addressIndexes: true`; `partitionBlocks`
  default.
- Lanes are added when the explorer goes live: an `insights` block with
  `rpc` blockdaemon, beamrpc, then the public endpoint, `startBlock: -2000`
  and `laya` the gate with its header Secret (created by the user; the token
  is never read here). Until then `_insights` is empty and the explorer
  shows rows without lanes.

Tables: `usdc_transfer(block_number, tx_hash, log_index, from_id, to_id,
value)`; `poolmanager_initialize`, `poolmanager_swap`,
`poolmanager_modify_liquidity`, `poolmanager_donate`; `_blocks`,
`_addresses`, `_insights`, `_labels`, `_sentences`, `_cursor`,
`_insights_cursor` (the last five exist once insights are on).

Size, from layout 2's measurements: ~13 GB of history, ~1–2 GB more for the
ordered address indexes (20–50 bytes per transfer row over single-column
ones), then ~0.6 GB a day (transfers 0.29, pool events 0.09, lanes 0.18,
blocks 0.02). A 100 GB volume holds about 140 days after launch; the
explorer's footer shows the database size so the limit is seen coming.

## Explorer-owned data (schema `explorer`)

- **`address_daily(address_id integer, day date, in_value numeric,
  out_value numeric, in_count integer, out_count integer, PRIMARY KEY
  (address_id, day))`** — USDC received and sent per address per UTC day.
  An address page's totals and chart over the whole history come from here,
  never from scanning its transfers. A self-transfer counts on both sides.
- **`rollup_cursor(block_number bigint)`** — the last block folded in.
- **`tokens(address bytea PRIMARY KEY, symbol text, decimals smallint,
  read_at timestamptz)`** — pool currencies' `symbol()`/`decimals()`, read
  once over `ARC_RPC` the first time a page needs them (address(0) in a v4
  pool is native USDC, 18 decimals, never read). A token that answers
  neither is stored with nulls and shown by its short address.
- `ensureExplorerSchema()` creates these at start (`IF NOT EXISTS`); there are
  no migrations yet.

**The rollup job** folds `usdc_transfer` into `address_daily` in block
ranges, one transaction per range: aggregate the range's rows on both sides
(joined to `_blocks` for the day), upsert with `in_value = address_daily.
in_value + excluded.in_value` (and likewise), advance `rollup_cursor`. Rows
and cursor commit together, so a crash re-folds nothing twice. It runs up to
the worker's `_cursor`: first through the backfill in 50,000-block ranges,
then every 2 s on whatever is new. Address pages show "totals up to block
N" while it is behind.

## Home: the tape

### Server: the tailer

One loop per process, every 250 ms:

1. Read the worker's `_cursor` and `_insights_cursor`.
2. Choose how far to release: up to the insights cursor, plus any later
   block whose `_blocks._ingested_at` is older than `LANE_HOLD_MS` by
   Postgres's own clock (`now()`), never past `_cursor`. A row
   therefore waits for its lane at most 8 s; A2 targets ≤ 5 s at p95, so
   almost every row reaches viewers with its lane, and the tape runs a few
   seconds behind the chain rather than showing a column of blanks. (At
   ~14 movements a second a 32-row tape replaces itself every ~2 s; lanes
   filled in afterwards would land on rows no one sees.)
3. Read the released blocks' transfers with their lanes and addresses (one
   query over `usdc_transfer` ⋈ `_blocks` ⋈ `_addresses` ⋈ `_insights` ⋈
   `_labels`, by primary key range), group them by block, and publish one
   `block` message per block.
4. Fold them into a rolling 60 s window: count, USDC sum (bigint), count per
   lane, the five largest movements (one per transaction). Publish a
   `stats` message once a second.

The tailer keeps the last 40 movements and the latest `stats` for viewers
who connect. A row released without a lane (the hold ran out) carries
`lane: null`; its lane is not sent later — the tape has moved on, and the
transaction page has it.

### Stream: `GET /api/stream`

`text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`. Messages:

| event | data |
|---|---|
| `hello` | the 40 latest movements and the latest `stats` |
| `block` | `{ n, t, moves: [{ tx, li, from, to, fromName?, toName?, value, lane }] }` — `value` a decimal string in USDC |
| `stats` | `{ count, usdc, perSec, lanes: {lane: n}, largest: [...] }` |
| (comment) | heartbeat every 15 s, inside Cloudflare's 100 s idle limit |

`id:` is the block number. A reconnect with `Last-Event-ID` gets the blocks
after it from the 40-movement buffer when they are still in it, else a fresh
`hello`. Beyond `MAX_STREAMS` open streams the server answers 503 and the
client retries with backoff.

### Client

- The tape keeps the mockup's look: time, lane tag, `from → to` (named
  contracts by name), amount. Rows enter at the top.
- **Pacing.** A `block` message's rows are spread evenly over the time until
  the next one is expected (the median gap of the last 20 blocks, ~0.5 s), so
  the tape flows instead of jumping. A backlog over 3 s is drained faster
  rather than delayed further.
- **Hover pauses.** While the pointer is on the tape no row enters, so the
  row under it can be clicked; a "12 new" marker counts what waits, and the
  backlog drains on leave. Keyboard focus on a row does the same.
- The headline ("In the last minute **13,680 USDC** moved across Arc in
  **161** movements; **123** of them were swaps."), "Largest this minute" and
  "By lane" are rendered from `stats`.
- The masthead's "● Arc mainnet, live" turns grey with "reconnecting" while
  the stream is down, and "n s behind" when the newest block shown is more
  than 15 s old.
- Phone width: one column; the tape hides `from → to` below 520 px.

## Transaction page: `/tx/[hash]`

Server-rendered from the rows sharing the hash (`tx_hash` index on each
table):

- **Headline**, a sentence written from the rows: "0x6f2a…91c3 swapped
  **312.40 USDC** on Uniswap v4." / "0x88a5…55e0 paid 0x1c40…e111 **311.55
  USDC**." / "**10,000 USDC** were minted to 0x…". Under it, the block, time
  and a one-line account of the path.
- **How the money moved** — the transfers in log order as a chain of nodes
  and arrows when they form one and number ≤ 6, else the event list only.
- **Swap box** for each v4 `Swap`: paid and received, in each currency's
  symbol and decimals (pool from `poolmanager_initialize` by pool id;
  `amount0`/`amount1` read as Uniswap v4's swapper-side deltas — negative is
  paid into the pool — checked against a known mainnet swap in tests).
- **Events in this transaction** — every indexed row, in log order.
- **Lane** — the lane tag, its probability, and the sentence Laya read
  (`_insights_full`). Ruled lanes say what ruled them. Before lanes began
  (a block below the first `_insights` row's, read once at start): "Arckive
  began reading lanes on <date>; this transaction is older." Not
  read yet: "Laya is reading this transaction"; the page polls
  `/api/tx/[hash]/lane` every 2 s for up to 30 s.
- **Facts** — hash, block, time (UTC), protocol, pool, parties linked to
  their address pages.
- Unknown hash: a 404 in the same design — "Arckive has no USDC or Uniswap
  v4 event in this transaction" — with the search box.

## Address page: `/address/[address]`

- **Headline** written from totals: "A wallet that received **48,211.07
  USDC** and sent **47,950.00 USDC** across **1,214** movements since 3 June
  — mostly payments." Contract or wallet is not known without a call and is
  not claimed; a named contract (below) is called by its name.
- **Stats**: received, sent, net, movements — whole history, from
  `address_daily`.
- **Chart**: USDC in above the line, out below, per day over the address's
  whole history (from `address_daily`); the mockup's per-minute bars become
  per-day bars.
- **History**: 25 movements per page, newest first, by keyset
  (`?before=<block>-<log>`): the two index scans (`from_id = $1`, `to_id =
  $1`, each `ORDER BY block_number DESC, log_index DESC LIMIT 26`) merged and
  cut to 25. Each row: time, IN/OUT, counterparty, lane, amount, tx link.
- **Most frequent counterparties** and **By lane**: over the latest 1,000
  movements, and labelled so.
- An address Arckive has never seen: "No USDC movement for this address
  since 2026-05-15." Uppercase or mixed-case input is normalised; a 42-char
  input that is not hex is a 404.

## Search and names

- The masthead input routes on submit: 66-char `0x` hex → `/tx/…`, 42-char
  → `/address/…`; anything else shows a one-line hint under the box. No
  partial matching in v1 (D brings questions).
- **Names**: a small static map of contracts verified on Arc's explorer at
  implementation time (the PoolManager as "Uniswap v4 Pools", the Universal
  Router, Permit2, …). Unverified addresses are never named.

## Visual system

Taken from the mockups (`detail-common.css` tokens): paper `#f4f1ea`, sheet
`#faf8f3`, ink `#15171b`, dim `#5b616c`, faint `#8b8f97`, hair `#ddd6c9`,
rule `#c9c1b2`; in `#1d8a57`, out `#b2412f`; lane inks payment `#3550c8`,
swap `#7442d1`, bridge `#0b7fb0`, liquidity `#1d8a57`, vault `#8d55e8`,
lending `#a87800`, signed payment `#2a7fa8`, issuance `#c06a12`, spam
`#8b8f97`. Newsreader for headlines and numbers, Inter for labels,
JetBrains Mono for hashes and times, through `next/font` (self-hosted, no
request to Google at runtime). Lane order and names come from core's
`LANES`. Amounts: two decimals, "<0.01" below a cent; tabular figures.
Times in UTC, labelled.

## Failure behaviour

- Database unreachable: pages answer 503 in the same design ("The archive is
  not answering; the tape will resume on its own"); the tailer retries every
  second; streams stay open and show "reconnecting".
- Worker behind or stopped: the tape shows "n s behind"; pages work on what
  is there.
- Insights down: rows are released after the hold without lanes; the "By
  lane" panel says "lanes paused" when more than half of the last minute has
  none.
- Token metadata unreadable: short address instead of a symbol, raw amount
  with "(decimals unknown)".
- Slow query: the 5 s statement timeout turns it into the 503 page, never a
  hung request.

## Performance targets (measured on k3d with the full history)

- `/tx/[hash]`: server time < 150 ms at p95.
- `/address/[address]`: < 300 ms at p95 for the 20 busiest addresses.
- Tailer: one cycle < 50 ms at 50 movements/s.
- 500 concurrent streams: < 1 CPU core, < 300 MB memory for the process.
- Tape latency: block time → row on screen ≤ `LANE_HOLD_MS` + 1 s.

## Testing

- **Unit (vitest):** search routing; amount and time formatting; headline
  sentences for payment, swap, mint, burn, self-transfer; release rule of the
  tailer (insights cursor, hold, empty blocks); the rolling window
  (expiry, largest-per-transaction, lane counts); SSE framing, `hello`,
  `Last-Event-ID` resume and the stream cap; client pacing (spread, catch-up
  over 3 s) and hover pause as pure functions.
- **Database (testcontainers, PostgreSQL 17):** a layout-2 schema built with
  core's DDL and the worker's bootstrap, with fixture rows covering a swap
  transaction, a payment chain, a mint and an address with > 25 movements.
  Tx and address queries return the expected shapes; keyset paging has no
  gaps or repeats across pages; the rollup equals a direct `SUM` over the
  table after folding in uneven ranges and after a simulated crash between
  ranges; the explorer role cannot write to the worker's schema.
- **Browser smoke (Playwright, local, not in CI):** against the fixture
  database with a fake tailer feed — the tape fills and flows, hover pauses,
  clicking a row opens its transaction, search routes both ways, pages render
  at 1440 px and 390 px. Screenshots go into the PR.
- **Real (k3d, after A2):** the performance targets above, a day of the live
  tape, and a visual review with the user before C.

## Deployment

Next to the Indexer and the database in `manifests/arc-mainnet/k8s/`:
`explorer-role.sql` (above, applied once by hand with `psql`) and
`explorer-app.yaml` — the explorer Deployment (one replica, the image built
locally and imported with `k3d image import`, like the worker and operator
in tests) and its Service, with its DSN in a Secret `explorer-dsn` created by
hand and never committed. Publishing it — the tunnel or host that serves a
preview hostname, its token, DNS records — and the Laya header Secret for
lanes are done with the user at deploy time. Restarting the k3d cluster is
done with the user's go-ahead.

## Risks

- **The Mac is the server.** Sleep, restarts and disk fill take the site
  down; the tunnel returns Cloudflare's error page meanwhile. Accepted for
  v1; moving the database is a later choice the schema does not prevent.
- **Backfill time.** ~25M blocks over the public endpoint's quota takes
  hours; the burst around 2026-09-15 (90–180 logs a block) needs small
  `getLogs` spans, which `RangeSizer` finds. The explorer can open before the
  backfill ends: address totals say "up to block N".
- **Hold vs. freshness.** If lanes lag more than the hold, rows go out
  without them. The hold is one env var; the metric to watch is A2's
  `insights_blocks_behind`.
