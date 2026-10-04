# Arckive

Kubernetes-native, self-hosted contract-event indexer for Arc (Circle's
stablecoin-focused EVM L1). You declare an `Indexer` custom resource; the
operator provisions a worker, the worker bootstraps the schema/tables and
streams events into **your own Postgres** — one table per event, readable
with plain SQL.

```
kubectl apply (ConfigMap[ABI] + Indexer CR + Secret[DSN])
        │ watch/reconcile
        ▼
[ Operator ] ──provisions──▶ worker Deployment + config ConfigMap
                              │
Arc RPCs ──WS newHeads + poll fallback──▶ [ Worker ] ──single tx──▶ [ Postgres ]
                                          └──status patch──▶ Indexer .status
```

## Quickstart (2 commands)

Prerequisites: a running Kubernetes cluster and a reachable Postgres.

```bash
# 1) Install the operator (CRD included)
kubectl apply -f https://arckive.org/install.yaml

# 2) DSN Secret + Indexers — no ABI ConfigMaps (auto-fetched from the explorer)
kubectl apply -f https://arckive.org/demo.yaml

# Watch
kubectl get indexers
# NAME       PHASE   CURRENT   HEAD      LAG
# usdc-arc   Live    8123456   8123456   0
```

Each contract's ABI is auto-fetched from the chain's block explorer by address
(override with `abi.configMapRef` or `abi.inline`). Omitting `startBlock` tails
from the current head; set it to backfill from a specific block. The demo bundle
(`manifests/arc-testnet/k8s/demo.yaml`) is a Secret + two Indexers; write your
own for real use.

`install.yaml` is generated from the chart by `scripts/build-install.sh`
(Namespace + CRD + operator; images
`ghcr.io/goguzgungor/arckive-{operator,worker}:latest`) and published to a
GitHub Release on every push to `main`. The Helm path still works if you want
your own images: `helm install arckive charts/arckive
--set image.repository=... --set workerImage.repository=...`

Add a `wss://` endpoint to the `rpc` list and the worker sees each new block
instantly via `eth_subscribe(newHeads)`; otherwise it polls every
`polling.intervalMs` (which stays on as a safety net even with WS). Endpoints
that announce fast but rate-limit queries can go into `announceRpc` — they are
listened to only and never queried.

Data: `<contract>_<event>` tables in an `idx_<indexer>` schema
(e.g. `idx_usdc_arc.usdc_transfer`) plus `_cursor`, `_meta`, `_dead_letter`
control tables. Deleting the CR cleans up the worker resources and **never
touches the DB**.

## Insights (optional)

A log says *what* a contract emitted; it does not say *what kind of
transaction* that was. A `Transfer` reads the same whether it is a swap leg, a
bridge deposit or a payroll payment. With `spec.insights` set, the worker
works that out for every event it indexes and writes it next to the event:
the **lane** (`swap`, `bridge`, `liquidity`, `vault`, `lending`,
`signed_payment`, `payment`, `spam`, `issuance` for mint/burn, or
`uncertain`), the **protocol** that handled the transaction, and the **facts**
that placed it. The lanes are decided by Laya, a local decision model, through
a model gate you run (the same one behind Arc Radar, `radar/`); the worker only
needs its URL and one header.

```yaml
apiVersion: v1
kind: Secret
metadata: { name: laya-gate }
stringData:
  header: "Authorization: Bearer <token>"
---
apiVersion: arckive.org/v1alpha1
kind: Indexer
spec:
  # ...network, storage, contracts...
  insights:
    laya:
      url: https://laya-gate.example.com     # /ai/run/batch and /health are appended
      headerSecretRef: { name: laya-gate }   # optional; key defaults to "header"
```

Results land in `idx_<indexer>._insights`, keyed like the event rows:

```sql
SELECT t.block_time, t.value, i.lane, i.lane_p, i.protocol
FROM idx_usdc_arc.usdc_transfer t
JOIN idx_usdc_arc._insights i USING (block_number, tx_hash, log_index)
WHERE i.lane = 'bridge'
ORDER BY t.block_number DESC LIMIT 20;
```

`lane_p` is the model's confidence (NULL when the transaction itself decides
the lane — mint/burn, zero-value spam, unreadable); `probabilities` keeps the
whole distribution, and `sentence` is exactly what the model read.

Insights run in their own loop behind the ingest cursor. Ingest never waits for
the model: if the gate is slow, rate-limited or down, insights fall behind
(`arckive_insights_blocks_behind`) and catch up, and the indexer stays `Live`.
The worker sends at most 64 sentences per call and one call a second, and
caches answers per sentence.

Insights also share your RPC endpoints with ingest, so they take second place
there too: they read each block once (`eth_getBlockByNumber` +
`eth_getBlockReceipts` — the endpoint must support the latter), one call at a
time, and only while ingest is `Live`. Their pace starts at four calls a second
and adapts: it halves whenever an endpoint answers "rate limited" or ingest is
failing, and creeps back up (to at most twenty a second) while calls go
through. With more
than one entry in `network.rpc`, insights use the list from the back, so their
reads land on a different endpoint's rate limit than ingest's. Give them one:
Arc mainnet's public RPC has a per-minute quota that ingest alone, polling once
a second, already runs into. History is classified too, from the indexer's
start block, once ingest has caught up.

**How good is it?** For USDC on Arc the sentence the model reads is
byte-for-byte Radar's (a test pins this against 1,200 captured mainnet
transfers), where lanes agreed with an audited fact table 99.9% of the time.
For any other contract or token the sentence is new to the model — the event
and function names from your ABI stand in for Radar's protocol tables — and
its accuracy is **unmeasured**. Read a sample before trusting it:

```sql
SELECT lane, lane_p, protocol, sentence, tx_hash
FROM idx_<indexer>._insights ORDER BY random() LIMIT 50;
```

## Benchmarks

Every number comes from running the real worker and reading only its
production surface (Postgres rows + `/metrics`) — no benchmark
instrumentation in product code:

| Measurement | Result | Context |
|---|---|---|
| Block → SQL, p50 | **395ms** (p99 0.97s) | Arc public testnet USDC, WS `newHeads` listening; official endpoint in `announceRpc`, queries on drpc |
| Backfill | **92.6 blocks/s** | 5,107 blocks of real USDC history in 55s — ~48× faster than the chain, zero RPC errors |
| Burst ingest | **2,628 events/s** | Local anvil; decode + single-transaction SQL write ceiling |
| Provider floor | ~0.75–0.9s (p50) | The official endpoint's `newHeads` announce lag — the part of the budget outside the indexer (the engine itself adds ~40ms) |

Freshness is read from the product's own meta columns
(`_ingested_at − block_time`); a run is invalidated if the WS connection does
not stay up for the whole window. When Arc mainnet launches, the same suite
runs there with a single `NETWORKS` entry. Raw results and the HTML report
live in `docs/benchmarks/` · reproduce with `pnpm bench`
(prerequisite: `docker compose -f docker-compose.dev.yml up -d postgres anvil`).

## Observability

The worker serves `:9090/metrics` (Prometheus) and `:9090/healthz`:
`arckive_blocks_behind`, `arckive_events_ingested_total`,
`arckive_rpc_errors_total`, `arckive_last_processed_block`,
`arckive_dead_letter_total`, `arckive_write_latency_seconds`,
`arckive_ws_connected`, `arckive_head_notifications_total`, and with insights
`arckive_insights_blocks_behind`, `arckive_insights_classified_total{lane}`,
`arckive_insights_model_calls_total`, `arckive_insights_cache_hits_total`,
`arckive_insights_errors_total{stage}` (`stage` = `model`, `rpc` or `db`).
Insight failures never mark the indexer `Degraded`: `/healthz` and the CR phase
describe ingest only.

## Development

```bash
pnpm install
pnpm -r build && pnpm -r test        # unit + integration (needs Docker + Foundry)
docker compose -f docker-compose.dev.yml up   # operator-less local demo (anvil + pg)
pnpm demo:seed                                # deploy the demo contract + 10 events
./scripts/kind-dev.sh                         # kind development environment
pnpm e2e                                      # end-to-end on kind (needs kind + helm)
```

Note: Helm applies the CRD only on first install (from `crds/`); CRD updates
are applied manually with `kubectl apply -f charts/arckive/crds/indexer.yaml`.
