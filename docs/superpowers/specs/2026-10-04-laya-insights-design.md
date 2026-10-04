# Laya insights in the worker — design

Date: 2026-10-04 · Status: approved in conversation · Branch: `feat/laya-insights`

## Goal

An `Indexer` can opt into **insights**: for every event it indexes, the worker
works out, in near real time, what kind of transaction that event was part of —
the lane (swap, bridge, liquidity, vault, lending, signed payment, payment,
spam, mint/burn, or uncertain), the protocol that handled it, and the facts
that placed it — and stores that next to the events in the user's Postgres.

None of this is in an event log. A `Transfer` reads the same whether it is a
swap leg, a bridge deposit or a salary; what tells them apart is the rest of
the transaction. Arc Radar (`radar/`) already does this for USDC transfers on
Arc mainnet with Laya, a local decision model served by layad behind an
authenticating gate, at 99.9% lane agreement with an audited fact table. This
feature brings that machinery into the worker and generalises it from USDC to
whatever contracts the `Indexer` names.

The only input from the user is **where the model is** (a URL) and **one
header** to send it (typically `Authorization: Bearer …`).

## Out of scope

- Viewer questions (Radar's yes/no `noul` questions, the question gate, the
  story sentence, bridge direction, the control question). Lanes only.
- Running the model or the gate. The worker is a client of an existing gate
  (`/ai/run/batch`, `/health`), e.g. `https://laya-gate.brages.uk`.
- Exposing the lane set, batch size, thresholds or rate limits as config.
- New `.status` fields on the `Indexer` CR. Insight health is visible through
  metrics and logs.
- Radar's feed-level filtering (folding ERC-20/native twin logs, skipping
  EntryPoint gas refunds). Those decide which rows exist; the indexer already
  decided that, and insights classify every row it wrote.

## Decisions

| Question | Decision | Why |
|---|---|---|
| What is classified | Every indexed event, one insight per event row | The user's target is "the given custom contract or token", not only USDC |
| Where results live | One `_insights` table per schema, keyed like the event rows | Event tables stay untouched (benchmarks, DDL, hot-path writes unchanged); "not classified yet" is simply "no row" |
| Inline or separate | A separate loop with its own cursor, behind the ingest cursor | The gate is shared, rate-limited (240 calls/min across all clients) and has had outages (9.5 h on 2026-09-29). Ingest must never wait on it |
| History | Insights start at the same resolved start block as ingest and cover everything, in block order | Complete data; a tail-mode indexer (no `startBlock`) has no backfill and is real-time from the start |
| Header transport | A `Secret` holding the whole header line, injected as `INSIGHTS_HEADER` | The header carries a token; `config.json` is a plain ConfigMap. Same pattern as the DSN |
| Sentence for known protocols | Byte-identical to Radar's `shape` sentence | Radar's measured accuracy transfers only if the model reads the same text |

## Configuration surface

```yaml
apiVersion: arckive.org/v1alpha1
kind: Indexer
spec:
  # ...existing fields...
  insights:                       # optional; absent = feature off, nothing changes
    laya:
      url: https://laya-gate.brages.uk
      headerSecretRef:            # optional (a gate without auth needs none)
        name: laya-gate
        key: header               # default 'header'
---
apiVersion: v1
kind: Secret
metadata: { name: laya-gate }
stringData:
  header: "Authorization: Bearer 3f9c…"
```

- `url` must be `http(s)://`. `/ai/run/batch` and `/health` are appended to it.
- The secret value is a single header line, `Name: value`. The worker splits it
  at the first `:` and trims both sides; a value without `:` or with an empty
  name fails worker startup with a clear error (the header is never logged).
- Changing a spec field follows CLAUDE.md's chain:
  1. `charts/arckive/crds/indexer.yaml` — `insights.laya.{url, headerSecretRef.{name,key}}`.
  2. `packages/core/src/crd.ts` — `IndexerSpecSchema.insights`; `renderWorkerConfig`
     passes `insights.laya.url` through (never the secret).
  3. `packages/core/src/config.ts` — `WorkerConfigSchema.insights` (`{ laya: { url } }`, optional).
  4. `packages/operator/src/resources.ts` — when `headerSecretRef` is set, add env
     `INSIGHTS_HEADER` from `secretKeyRef`.
  5. Tests — CRD↔zod parity picks up the new top-level field; render tests.
  6. `scripts/build-install.sh` — regenerate `install.yaml`.
- Operator validation: a missing header Secret sets `Provisioned=False` with
  reason `MissingInsightsSecret`, like `MissingDsnSecret`. No exception.
- Because `url` lives in `config.json`, changing it rolls the worker through the
  existing `arckive.org/config-hash` annotation. Rotating the Secret's value does
  not roll the pod (same as the DSN today); a restart picks it up.

## Architecture

```
ingest loop (UNCHANGED) ──commitBatch──▶ event tables + _cursor
                                               │  rows up to _cursor are complete
insight loop (NEW) ◀──reads────────────────────┘
  1. rows in (_insights_cursor, _cursor], capped per round
  2. tx context: tx + receipt per tx; getCode per party (LRU); factory() per pool (LRU)
  3. sentence + ruled lane per row             (pure, @arckive/core)
  4. unruled sentences → Laya, cached per sentence, ≤ 64 per call
  5. _insights rows + new _insights_cursor     (one transaction)
```

Rows up to `_cursor` are complete because ingest writes rows and cursor in one
transaction. The insight loop therefore never sees a half-written range and
never passes the ingest cursor.

### `@arckive/core` — pure logic (no RPC, no DB)

`packages/core/src/insights/`:

- **`signatures.ts`** — TypeScript port of `radar/radar/signatures.py`:
  `FACT_ORDER`, `FACT_PHRASE` (lane wording only), `FACT_BY_SELECTOR`,
  `FACT_BY_TOPIC`, `POOL_TOPICS`, the protocol rules, `UNISWAP_*`,
  `FACTORY_NAMES`, `venueOf`, `protocolOf`, `factsOf`. The audit comments that
  justify individual entries (Relay's `FundsMovement`, WETH-style
  `Deposit`/`Withdrawal` as wrap) are carried over. `STORY_PHRASE`,
  `BRIDGE_OUT/IN` and `bridge_direction` are not ported (questions only).
- **`sentence.ts`** — `TxContext` (`to, selector, topics, sender, emitters,
  factories`, as in `radar/radar/types.py`), and
  `describe(input) → { sentence, facts, protocol, ruled }` where `input` is the
  event row (table, event definition, decoded columns, contract address and
  name), the tx context (or `null`), party kinds (`address → isContract`), the
  token label and decimals, and the function-name map of the indexed contracts.
  - **Transfer-shaped events** — `topic0` is the ERC-20 `Transfer` topic and the
    event has three inputs `(address, address, uint256)`. Head and tail exactly
    as Radar's `shape`, with `USDC` replaced by the token label and amounts
    bucketed in the token's own decimals: `"<T> moved from a wallet to a
    contract, amount 1 to 100 <T>. In the same transaction: …"`, mint/burn
    heads for the zero address. With label `USDC` and 6 decimals the output is
    byte-identical to Radar. If `decimals()` could not be read, the amount is
    `zero <T>` or `a nonzero amount of <T>`.
  - **Other events** — `"The <contract> contract logged <Event>."` followed by
    the same tail.
  - **Function name from the ABI** — when `tx.to` is an indexed contract and the
    selector is a function in its ABI, `"It was called with <fn>."` is added
    after the head. It is *not* added when the selector already maps to a fact,
    or is a plain transfer (`0x`, `transfer`, `transferFrom`): known-protocol
    sentences stay Radar's.
  - **Plain transfer** — Radar's `_plain` with `tx.to == USDC` generalised to
    `tx.to ==` the event's own contract.
  - **Ruled lanes** (Radar's `ruled_lane`, generalised):
    - no tx context → `uncertain`;
    - transfer-shaped, a zero-address side, no `bridge` fact → `issuance`;
    - transfer-shaped, value 0, no fact beyond `smart_account`/`fee` → `spam`;
    - transfer-shaped, no facts, not plain, no function name → `uncertain`.
    Other events are only ruled `uncertain` when their context is missing; with
    an event name to read they go to the model.
  - **Protocol** — `protocolOf(ctx)`; when it is empty and `tx.to` is an indexed
    contract, that contract's name; else `''`.
- **`lanes.ts`** — `LANES` and `LANE_QUESTION` copied verbatim, order included
  (moving one option cost 14 points of agreement on Arc); `UNCERTAIN_BELOW =
  0.35`; `settleLane(answer, ruled)` ported from `radar/radar/server.py`
  (model `spam` falls to its runner-up; outside the set or below the line is
  `uncertain`).
- **DDL** — `buildInsightsTables(schema)` in `ddl.ts`:

  ```sql
  CREATE TABLE IF NOT EXISTS "<schema>"._insights (
    block_number  bigint NOT NULL,
    tx_hash       text NOT NULL,
    log_index     integer NOT NULL,
    table_name    text NOT NULL,
    lane          text NOT NULL,
    lane_p        real,              -- NULL when ruled
    ruled         boolean NOT NULL,
    protocol      text NOT NULL,
    facts         jsonb NOT NULL,    -- ["swap","fee"]
    probabilities jsonb,             -- full model distribution; NULL when ruled
    sentence      text NOT NULL,
    model         text,              -- layad /health "model"
    classified_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (block_number, tx_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS "_insights_lane_idx" ON "<schema>"._insights (lane);
  CREATE TABLE IF NOT EXISTS "<schema>"._insights_cursor (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_block bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ```

  Created only when insights are enabled. Inserts are `ON CONFLICT DO NOTHING`.

### `@arckive/worker`

- **`laya.ts`** — the gate client.
  - `classify(sentences) → Map<sentence, LaneAnswer>`: posts
    `{ states, questions: { lane: LANE_QUESTION } }` to `{url}/ai/run/batch` in
    chunks of at most 64 states (the GPU is shared; Radar's `BATCH_MAX`), reads
    `results[i].answers.lane.{choice, probabilities}`.
  - `identity()`: `GET {url}/health`, returns its `model` string.
  - Sends the configured header and a fixed `User-Agent: arckive-worker`
    (Cloudflare in front of the tunnel refuses some default agents).
  - Per-sentence LRU cache of 60,000 answers, keyed by the sentence (the lane
    question is fixed). Real traffic repeats a handful of shapes, so most of a
    round is a cache hit.
  - At most one request in flight and at most 60 calls a minute — a quarter of
    the shared gate's budget, so this worker cannot starve the radars.
  - 30 s timeout per call. `fetch` is injected (DI, as in `AbiDeps`).
- **`txcontext.ts`** — what Radar's `arc.py` `_items` does, through viem:
  - one `getTransaction` + `getTransactionReceipt` per distinct tx in the round,
    bounded concurrency (8), as `getBlockTimes` does; a tx or receipt that comes
    back `null` or malformed yields `null` context for its rows (ruled
    `uncertain`), a thrown RPC error fails the round;
  - `factory()` (`0xc45a0155`) per pool that logged a `POOL_TOPICS` event,
    cached; a pool that cannot answer is asked again after 10 minutes;
  - `getCode` per transfer party, cached (`isContract`: EIP-7702 delegated
    EOAs, `0xef0100` + 20 bytes, are wallets);
  - `symbol()` and `decimals()` once per transfer-shaped contract at startup;
    failure falls back to the contract's CR name and unknown decimals.
- **`insights.ts`** — `runInsightsOnce(deps)` and `runInsightsLoop(deps, signal)`.
  - `InsightsDeps`: `pool, schema, defs, contracts (names, function maps, token
    info), context source, classifier, metrics, log, batchBlocks, intervalMs,
    wake`. Context source and classifier are interfaces so tests inject fakes.
  - A round reads `_insights_cursor` and `_cursor`; plans a range of at most
    `polling.batchBlocks` blocks with `planRange`; caps it at 2,000 rows by
    moving `toBlock` back to the block before the 2,001st row (a single block
    larger than the cap is taken whole); reads the rows from every event table
    in the range; builds contexts, sentences, rulings; classifies the unruled
    sentences; writes `_insights` rows and the new cursor in one transaction.
  - Idle (cursor caught up): waits for a wake-up from the ingest loop or
    `polling.intervalMs`, whichever is first. The ingest loop gets one optional
    hook, `PipelineDeps.onCommitted?.()`, called after `commitBatch`; this is the
    only change to the ingest path.
  - Errors: back off 1 s → 60 s and retry the same range. Nothing is written for
    a failed round.
- **`main.ts`** — when `cfg.insights` is set: parse `INSIGHTS_HEADER`, keep the
  full ABIs (today only events are extracted) to build the function-name maps,
  read token info, create the insights tables and cursor (initialised like
  `_cursor`, to the minimum resolved `startBlock − 1`), start
  `runInsightsLoop` alongside `runLoop`, and stop it on shutdown.

## Error handling

- Insight failures **never** touch `PhaseTracker`: `/healthz` and the CR phase
  describe ingest only. A dead gate must not get the pod restarted or the
  indexer marked `Degraded`.
- Model call fails (network, timeout, 401/403, 429, 5xx, malformed body) → the
  round fails; `arckive_insights_errors_total{stage="model"}`; backoff. A 401 or
  403 is logged once per streak as "gate rejected the header" (the header value
  is never logged).
- RPC fails → same, with `stage="rpc"`.
- A state whose answer is missing from the response fails the round; a lane
  outside `LANES` is settled to `uncertain`.
- Model identity is fetched at loop start and again after a failed round; a
  missing identity leaves `model` NULL and does not block classification.

## Metrics

Added to the existing registry (default label `indexer`):

| Metric | Type | Meaning |
|---|---|---|
| `arckive_insights_blocks_behind` | gauge | `_cursor − _insights_cursor` |
| `arckive_insights_classified_total{lane}` | counter | insight rows written |
| `arckive_insights_model_calls_total` | counter | calls made to the gate |
| `arckive_insights_cache_hits_total` | counter | sentences answered from cache |
| `arckive_insights_errors_total{stage}` | counter | failed rounds, `stage` = `model` or `rpc` |

## Testing

- **Radar parity (core).** A generator, `radar/scripts/export_parity.py`, runs
  Radar's own `summarize` over `radar/tests/fixtures/live_sample.json` (1,200
  live mainnet transfers) and writes the distinct inputs with their expected
  `shape`, `ruled`, `facts` and `protocol` to
  `packages/core/test/fixtures/radar-parity.json`. `insights-parity.test.ts`
  asserts the TypeScript port reproduces every one of them for label `USDC`,
  6 decimals. This is the proof that Radar's measured accuracy carries over to
  USDC; it is not a claim about custom contracts.
- **Core unit tests** — generic heads, function-name rule, ruled lanes for
  non-transfer events, decimals fallback, `settleLane`, DDL.
- **Worker** — `laya.test.ts` (fake fetch: header and User-Agent sent, chunks of
  ≤ 64, cache hits, error mapping, rate limit); `insights.test.ts` on
  testcontainers Postgres with fake context source and classifier (range cap,
  never passes `_cursor`, idempotent re-run, failed classify writes nothing and
  leaves the cursor); `txcontext.test.ts` on anvil (wallet vs contract parties,
  null-receipt handling) plus unit tests for `isContract`.
- **Operator** — env rendered from `headerSecretRef`, `MissingInsightsSecret`
  condition, CRD↔zod parity.
- **Live check (manual, before merge)** — run the worker against Arc mainnet
  USDC (`0x3600…0000`, chain 5042) in tail mode with the real gate for a few
  minutes, confirm `_insights` fills and lanes look like Radar's. Kept short:
  the gate is shared with two live radars.

## Honest status to document

- USDC on Arc: sentences match Radar's byte for byte, so Radar's measurements
  (99.9% lane agreement on its audited ten minutes) apply to the lane the model
  is asked, given the same facts.
- Custom contracts and other tokens: **unmeasured.** The sentence is new text to
  the model. README says so and gives an audit query
  (`SELECT lane, sentence, tx_hash … ORDER BY random() LIMIT 50`) for reading a
  sample by hand; no accuracy figure is claimed until such an audit is done
  against independently established truth.

## Docs

README (feature, CR snippet, metrics list, honest status), CLAUDE.md (a short
"Insights" entry under key mechanics: separate loop, never blocks ingest, never
touches phase; parity fixture must be regenerated when Radar's tables change),
regenerated `install.yaml`.
