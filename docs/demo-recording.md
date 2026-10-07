# Arckive — Demo Recording Guide

A ≤5-minute technical video for the Circle grant. Circle asks for two things:

1. **Codebase walkthrough** — show the actual code where USDC / EURC are used.
2. **Live integration demo** — show the product working end to end.

The environment is pre-staged. The cluster is a **clean slate**: Arckive is *not*
installed, so `kubectl apply -f https://arckive.org/install.yaml` installs it
fresh **on camera**. Postgres (your "own database") is already running.

---

## 0. Prerequisites (already up)

- k3d cluster **`mycluster`** (k3s in Docker). If stopped: `k3d cluster start mycluster`
- In-cluster **Postgres** — your own-database stand-in (kept running, schemas empty)
- **pgweb** DB browser at <http://localhost:8082> (if down: see §4)
- Internet — the operator image pulls from GHCR (public, multi-arch)

Sanity check before recording:

```bash
kubectl get crd | grep arckive || echo "clean — operator not installed yet"
curl -s -o /dev/null -w "install.yaml: %{http_code}\n" https://arckive.org/install.yaml
```

---

## Part A — Codebase walkthrough (open these in your editor)

Open the files below and talk through them. Keep USDC/EURC front and center —
that is the "where Circle tech is used" answer.

| File · line | What to say |
|---|---|
| `manifests/arc-testnet/k8s/indexer.yaml:21,25` | "The entire USDC integration is one declarative CR: native USDC `0x3600…0000`, `events: [Transfer]`, chainId `5042002`, and `announceRpc` on Arc's official endpoint." |
| `manifests/arc-testnet/k8s/flowswap-indexer.yaml:19,23` | "Same CR shape for a live DEX (FlowSwapAMM) trading USDC↔EURC — `Swap`, `LiquidityAdded`, `PoolCreated`." |
| `packages/core/src/ddl.ts:57` (+ `:19`) | "`buildEventTable` turns a USDC `Transfer` into a typed SQL table; the `_ingested_at` column (line 19) is what makes freshness measurable." |
| `packages/worker/src/pipeline.ts:44-80` | "The hot path: take the head from the WS signal, `fetchLogs`, decode each event, and `commitBatch` into your Postgres in a single transaction." |
| `packages/worker/src/ws.ts:43,62` | "A `newHeads` WebSocket subscription triggers an immediate fetch the moment a block is announced — that is the 395 ms, no polling in the critical path." |

---

## Part B — Live demo (two commands, on camera)

The operator image pulls from GHCR on first apply (~20–40 s); `rollout status`
waits for it. Postgres is assumed already running (your own database).

```bash
# 1) Install the operator + CRD
kubectl apply -f https://arckive.org/install.yaml
kubectl -n arckive-system rollout status deploy/arckive-operator

# 2) DSN Secret + both Indexers in one apply — no ABI ConfigMaps
#    (ABIs auto-fetched from the explorer; no startBlock = tail from head)
kubectl apply -f https://arckive.org/demo.yaml

# Watch them go Live, then live rows land in Postgres
kubectl get indexers -w
```

Expected on screen — because they tail from head, they reach Live almost
immediately and then new USDC/EURC events stream in:

```
NAME       PHASE   CURRENT    HEAD       LAG
usdc-arc   Live    53066520   53066520   0
flowswap   Live    53066520   53066520   0
```

---

## The pgweb beat — data landing in your Postgres

In pgweb (<http://localhost:8082>, **Query** tab) run this and re-run it a few
times so rows scroll in with a sub-second **freshness** column:

```sql
SELECT block_number, block_time, (_ingested_at - block_time) AS freshness,
       "from", "to", value
FROM idx_usdc_arc.usdc_transfer_hex
ORDER BY block_number DESC
LIMIT 15;
```

For the DEX (USDC↔EURC swaps):

```sql
SELECT block_number, (_ingested_at - block_time) AS freshness,
       token_in, token_out, amount_in, amount_out
FROM idx_flowswap.flowswap_swap_hex
ORDER BY block_number DESC
LIMIT 15;
```

`value` on USDC is 6-decimals (e.g. `4485098` = 4.485098 USDC).

---

## Shot list (fits in 5:00)

| Time | Screen | Beat |
|---|---|---|
| 0:00–0:30 | arckive.org + the install command | "Arc events — USDC/EURC first — as plain SQL in your own Postgres, one command." |
| 0:30–1:30 | `indexer.yaml` + `flowswap-indexer.yaml` | the declarative USDC/EURC integration surface |
| 1:30–2:15 | `ddl.ts` + `pipeline.ts` + `ws.ts` | event → SQL table; the 395 ms hot path |
| 2:15–3:45 | terminal: the Part B commands | install → secret/ABIs → indexers → `get indexers -w` going Live |
| 3:45–4:40 | pgweb query, re-run | live USDC/EURC rows with sub-second freshness |
| 4:40–5:00 | arckive.org/benchmarks.html | "395 ms p50, 92.6 blocks/s, 0 RPC errors. USDC + EURC today, CCTP next." |

---

## 4. Reset between takes

To record again from a clean slate:

```bash
kubectl delete indexer --all -A --ignore-not-found
kubectl delete ns arckive-system --ignore-not-found
kubectl delete clusterrole arckive-operator clusterrolebinding arckive-operator --ignore-not-found
kubectl delete crd indexers.arckive.org --ignore-not-found
kubectl delete secret pg-dsn --ignore-not-found
kubectl delete configmap usdc-abi flowswap-abi --ignore-not-found
kubectl exec deploy/postgres -- psql -U arckive -d arckive \
  -c "DROP SCHEMA IF EXISTS idx_usdc_arc CASCADE; DROP SCHEMA IF EXISTS idx_flowswap CASCADE;"
```

Restart pgweb if it dropped:

```bash
kubectl port-forward -n default deploy/postgres 15432:5432 >/tmp/pf.log 2>&1 &
pgweb --listen=8082 --url 'postgres://arckive:arckive@localhost:15432/arckive?sslmode=disable' >/tmp/pgweb.log 2>&1 &
```

---

## 5. After recording

- Record with QuickTime (**⌘⇧5**), keep it **≤5 minutes**.
- Upload to a **private/unlisted** link (Google Drive or YouTube-unlisted).
- Paste the link into the Circle form → *Video demo of the product*.
- Optional: attach the 30-second motion-graphics film as supporting material.
