# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

**Arckive** — a Kubernetes-native, self-hosted contract-event indexer for Arc
(Circle's stablecoin-focused EVM L1). A user declares an `Indexer` custom
resource; the operator provisions a worker Deployment; the worker bootstraps a
Postgres schema and streams decoded contract events into **the user's own
Postgres** — one table per event, queryable with plain SQL.

Naming note: the git repository/directory is `arclight`, but the product was
renamed to **arckive** (commit `5360e44`). All user-facing names, the API group
(`arckive.org`), package scopes (`@arckive/*`), image names, metric prefixes and
mount paths use **arckive**. Do not reintroduce "arclight" in new code or docs.
(`charts/arckive/templates/NOTES.txt` still contains one stale "Arclight" —
it is a known leftover, not a convention.)

```
kubectl apply (Secret[DSN] + Indexer CR [+ ConfigMap[ABI]])
        │ watch/reconcile
        ▼
[ Operator ] ──applies──▶ SA + Role + RoleBinding + ConfigMap[config.json] + Deployment
                              │
Arc RPCs ──WS newHeads + poll fallback──▶ [ Worker ] ──single tx──▶ [ Postgres ]
                                          └──status patch (direct API)──▶ Indexer .status
```

## Repository layout

| Path | Purpose |
|---|---|
| `packages/core` | `@arckive/core` — pure logic shared by operator and worker: zod schemas (CRD spec + worker config), ABI→event extraction, DDL generation, log decoding, naming, range planning. **No Kubernetes, Postgres or RPC dependencies** (only `viem` + `zod`). |
| `packages/operator` | `@arckive/operator` — watches `Indexer` CRs via `kubernetes-fluent-client`, renders desired K8s resources, patches CR conditions. |
| `packages/worker` | `@arckive/worker` — one process per `Indexer`: resolves ABIs, bootstraps tables, runs the ingest loop, serves `/metrics` + `/healthz`, patches `.status`. Also hosts the benchmark and demo scripts under `scripts/`. |
| `e2e` | `@arckive/e2e` — kind-based end-to-end test (`kind.test.ts`) plus its fixtures/manifests. |
| `charts/arckive` | Helm chart for the operator. `crds/indexer.yaml` is the CRD source of truth. |
| `manifests/` | Example/demo manifests: `demo/` (anvil-based local demo), `arc-testnet/` (real Arc testnet, incl. the published `k8s/demo.yaml` bundle). |
| `scripts/` | `build-install.sh` (generates `install.yaml`), `kind-dev.sh` (local kind env). |
| `docs/benchmarks/` | Benchmark results (`results.json`) + generated HTML report. |
| `install.yaml` | **Generated** — Namespace + CRD + `helm template` output. Never edit by hand. |
| `radar/` | **Arc Radar** — standalone Python app (not in the pnpm workspace): live wall of every USDC transfer on Arc mainnet, lanes decided by the local Laya model via layad. Reads RPC directly; does not use the operator or worker. See `radar/README.md`. |

Dependency direction is strictly `operator → core` and `worker → core`. The
operator and the worker never import each other.

## Commands

```bash
pnpm install                       # pnpm workspace, pnpm@10.12.1, Node >= 22

pnpm -r build                      # tsc per package (core must build before the others)
pnpm lint                          # eslint (typescript-eslint recommended)
pnpm -r test                       # vitest, all packages
pnpm --filter @arckive/core test   # single package

pnpm e2e                           # kind end-to-end (needs kind + helm + docker)
./scripts/kind-dev.sh              # local kind cluster + fixtures, run operator on the host
docker compose -f docker-compose.dev.yml up   # operator-less demo: anvil + postgres + worker
pnpm demo:seed                     # deploy the Emitter fixture + emit 10 events (needs foundry)
pnpm arc:preflight                 # probe an Arc RPC endpoint (chainId, finality lag)
pnpm bench                         # benchmark suite → docs/benchmarks/<date>/results.json
pnpm bench:report                  # render report.html from results.json
scripts/build-install.sh           # regenerate install.yaml from the chart
cd radar && .venv/bin/pytest -q    # Arc Radar tests (Python)
```

**Run `pnpm -r build` before `pnpm -r test`.** Only `packages/worker` aliases
`@arckive/core` to its `src/`; the operator's tests resolve `@arckive/core`
through the workspace link to `dist/`, so stale or missing builds break them.

Test prerequisites: **Docker** (worker DB tests use `@testcontainers/postgresql`)
and **Foundry/anvil** (worker RPC/WS/pipeline tests and `demo:seed` spawn
`anvil`). The e2e test additionally needs `kind` and `helm`.

## Conventions

- **TypeScript ESM throughout.** `module: NodeNext`, `strict`, and
  `verbatimModuleSyntax`. Relative imports carry the `.js` extension
  (`./naming.js`), and type-only imports must use `import type` /
  `type` specifiers.
- **Env vars are read with bracket notation** — `process.env['DATABASE_URL']` —
  consistently across the codebase.
- **Validate at the boundary with zod.** `IndexerSpecSchema` parses CR specs,
  `WorkerConfigSchema` parses the mounted `config.json`. Downstream code assumes
  parsed, defaulted values.
- **Dependency injection for testability.** Side-effecting collaborators are
  passed in as objects or optional overrides: `ReconcileDeps` / `KubeApi`
  (operator), `PipelineDeps` (worker pipeline), `AbiDeps` (`readFile` /
  `fetchJson` overrides in `worker/src/abi.ts`). Follow that pattern instead of
  mocking modules.
- **Named error subclasses** for domain failures: `AbiError`, `DdlError`,
  `DecodeError`, `NamingError`, `ChainIdMismatchError`.
- **Logging** is `pino`, structured-object-first: `log.info({ indexer, ns }, 'msg')`.
- **Comments explain the *why*** — especially non-obvious operational choices
  (reconcile-storm guard, `rank: false`, the WS `settled` latch). Keep that
  density; do not strip these comments when refactoring.
- **Repository language is English** — code, comments, commit messages, docs.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`,
  `refactor:`, `revert:`), and work lands on `main` via pull request.

## Key mechanics to know before changing things

### Adding or changing an Indexer spec field

The CRD schema is duplicated by design (OpenAPI for the API server, zod for
runtime). Changing a spec field means touching, in order:

1. `charts/arckive/crds/indexer.yaml` — OpenAPI v3 schema, printer columns.
2. `packages/core/src/crd.ts` — `IndexerSpecSchema` and, if it reaches the
   worker, `renderWorkerConfig`.
3. `packages/core/src/config.ts` — `WorkerConfigSchema` (the worker's view).
4. `packages/operator/src/resources.ts` — if it affects the rendered Deployment
   (volumes, env, mounts).
5. Tests: `packages/operator/test/crd-manifest.test.ts` asserts CRD↔zod
   parity of top-level spec fields; `core/test/crd.test.ts` covers rendering.
6. `scripts/build-install.sh` output — CI fails if `install.yaml` is out of sync
   (`git diff --exit-code install.yaml`), so regenerate and commit it.

Helm applies CRDs only on **first** install. CRD changes must be applied
manually: `kubectl apply -f charts/arckive/crds/indexer.yaml`.

### ABI resolution order

`abiPath` (mounted ConfigMap file) → `abiInline` → explorer auto-fetch by
address (`network.explorerApi`, defaulting per `chainId` via
`DEFAULT_EXPLORER_API`, Blockscout-style `…/api/v2/smart-contracts/<addr>`).
Contracts *without* a `configMapRef` get no ABI volume in the Deployment.

### startBlock semantics

`undefined` = tail from head (no backfill); negative = head-relative (last `|n|`
blocks, clamped at 0); `>= 0` = absolute. Resolved once in `worker/src/main.ts`
via `resolveStartBlock` so the pipeline only ever sees concrete numbers.

### Database schema and naming

- Schema per indexer: `idx_<snake_case(indexerName)>`; table per event:
  `<contract>_<event>` (plus a 4-hex-char topic0 suffix for overloads).
- Every event table gets `COMMON_COLUMNS` (block/tx/log identity) plus
  `_ingested_at` (DB default `now()`, used for freshness measurement) and
  `UNIQUE (block_number, tx_hash, log_index)`; inserts are
  `ON CONFLICT DO NOTHING`, making re-processing idempotent.
- Control tables per schema: `_cursor` (single row), `_meta`, `_dead_letter`.
- Column names are snake_cased; collisions with reserved names get a `param_`
  prefix; identifiers over 63 bytes raise `NamingError`.
- All identifiers are double-quoted; all values go through parameterized
  queries. Keep it that way.
- **Deleting an Indexer CR never touches the database.** Cleanup happens via
  `ownerReferences` GC on the K8s resources only. The e2e test asserts this.

### Ingest loop

`runOnce` reads the cursor, computes a range with `planRange`, fetches logs,
decodes them, and writes rows + dead letters + the new cursor **in a single
transaction** (`commitBatch`). Undecodable logs go to `_dead_letter` rather than
crashing the loop. `runLoop` retries on error with exponential backoff (1s → 30s)
and sets phase `Degraded`.

In `finalityTag: latest` mode the target head can come from the WS `newHeads`
signal (`HeadSignal.latestPrimaryHead()`), which removes a `getBlock` round-trip.
Because the query node may lag the announcing node, a **completeness guard**
runs `getFinalizedBlockNumber` in parallel with `getLogs` and commits only up to
`safeTo`. Do not remove that guard when optimizing the hot path.

### RPC and WebSocket handling

- `createRpc` builds a viem `fallback` transport with **`rank: false`** on
  purpose: config order is priority, and ranking would drift queries to a
  different node than the one announcing heads.
- `filterHealthyRpcs` drops endpoints whose `eth_chainId` mismatches or that are
  dead; the worker loops in `Degraded` (30s) while none are healthy.
- `announceRpc` endpoints are **listen-only** `ws(s)://` — they feed `newHeads`
  and are never added to the query pool.
- `subscribeNewHeads` fans in across all WS URLs with per-connection reconnect
  backoff; index 0 is the *primary* whose heads drive the hot-path target.
  `wsChainId` uses a `settled` flag to break the error→close→error recursion
  seen on Node 22/undici.
- Polling (`polling.intervalMs`) always stays on as a safety net, even with WS.

### Operator reconciliation

- `reconcile` is watch-driven plus a periodic resync (`RESYNC_INTERVAL_MS`,
  default 300000). Deleted CRs are ignored — `ownerReferences` handle cleanup.
- **Status is only patched when it actually changed.** Every patch produces a
  watch event; unconditional patching self-feeds into a reconcile storm (OOM).
  Preserve the `unchanged` check in `setCondition`.
- Validation failures surface as a `Provisioned=False` condition with reason
  `InvalidSpec` / `MissingAbiConfigMap` / `MissingDsnSecret` — no exceptions
  thrown at the caller.
- The worker Deployment carries an `arckive.org/config-hash` pod annotation
  (`configHash(workerConfig)`) so config changes trigger a rollout;
  `strategy: Recreate` keeps a single writer per indexer.
- The worker gets a narrow Role: `patch` on `indexers/status` for its own CR
  name only. The worker patches `.status` over raw HTTPS with its service
  account token (`worker/src/crstatus.ts`), not via a K8s client library.

### Runtime interfaces

Worker env: `DATABASE_URL` (required), `CONFIG_PATH` (default
`/etc/arckive/config.json`; the operator mounts `/etc/arckive/config/config.json`),
`HEALTH_PORT` (9090), `INDEXER_CR_NAME`, `INDEXER_CR_NAMESPACE`, `LOG_LEVEL`.
Operator env: `WORKER_IMAGE` (required), `RESYNC_INTERVAL_MS`, `HEALTH_PORT`
(8080), `LOG_LEVEL`.

Worker endpoints: `:9090/metrics` (Prometheus) and `:9090/healthz` (503 when
`Degraded`). Metrics are prefixed `arckive_` — `blocks_behind`,
`last_processed_block`, `events_ingested_total`, `rpc_errors_total`,
`dead_letter_total`, `write_latency_seconds`, `ws_connected`,
`head_notifications_total` — with an `indexer` default label.

Phases: `Provisioning` → `Backfilling` → `Live`, or `Degraded` on error.

### Benchmarks

`packages/worker/scripts/bench/` runs the **real worker** and reads only its
production surface (Postgres rows + `/metrics`). Do not add benchmark-only
instrumentation to product code — freshness is derived from
`_ingested_at − block_time`. Scenarios: `visibility`, `freshness`, `backfill`,
`burst`; select with `BENCH_SCENARIOS=...`. Results land in
`docs/benchmarks/<YYYY-MM-DD>/results.json` and are merged with same-day runs.
Prerequisite: `docker compose -f docker-compose.dev.yml up -d postgres anvil`.

## CI/CD

- `.github/workflows/ci.yml` (push + PR): `pnpm lint` → `pnpm -r build` →
  `pnpm -r test` → `helm lint`/`helm template` → `install.yaml` sync check;
  a separate job runs the kind e2e.
- `.github/workflows/release.yml` (push to `main`): builds and pushes
  multi-arch `ghcr.io/goguzgungor/arckive-{operator,worker}:{latest,sha-…}` from
  the multi-stage `Dockerfile` (`--target operator|worker`), uploads
  `install.yaml` to the rolling `latest` release, and syncs
  `install.yaml` + `manifests/arc-testnet/k8s/demo.yaml` to the `site-landing`
  branch (served at `arckive.org`).
- `.github/workflows/verify-install.yml` (manual): applies the published
  `install.yaml` to a fresh kind cluster.
- Arc Radar: the `radar` job in `ci.yml` runs `pytest` and `docker build` in
  `radar/`; `.github/workflows/radar-deploy.yml` (push to `main` touching
  `radar/**`) triggers the Dokploy deploy through the
  `DOKPLOY_RADAR_DEPLOY_URL` secret, and no-ops when it is unset.

Keep `README.md` (quickstart, benchmark table, metric list) in sync when
behavior visible to users changes.
