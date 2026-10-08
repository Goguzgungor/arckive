# Arckive for the explorer (A2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Arckive ready to feed the explorer: lanes within seconds of ingest at Arc mainnet load, lanes that start at a chosen block, ordered lookups by address, and an operator that no longer runs out of memory.

**Architecture:** Insight RPC reads move from one sequential, paced client onto a Radar-style endpoint pool that sends JSON-RPC batches of up to 20 calls, one request at a time, falling through to the next endpoint per call. Ingest stops flipping to `Backfilling` on every new block. Two new spec fields (`insights.rpc`/`insights.startBlock`, `storage.addressIndexes`) reach the worker. The operator stops reconciling on status-only watch events and replaces kubernetes-fluent-client's per-request connections with one keep-alive client of its own.

**Tech Stack:** TypeScript ESM (NodeNext), Node 22, viem 2.x (http transport `batch`), pg, vitest, testcontainers (PostgreSQL 17), anvil, kubernetes-fluent-client (watch only), @kubernetes/client-node 1.4.0, Helm, k3d.

**Spec:** `docs/superpowers/specs/2026-10-08-arckive-for-explorer-design.md`

## Global Constraints

- Work in the worktree `/Users/gokbot/Documents/projects/arclight-insights-throughput` (branch `feat/insights-throughput`). Before Task 1: `corepack pnpm install && corepack pnpm -r build` there. `pnpm` is not on PATH — always `corepack pnpm`.
- Run `corepack pnpm -r build` before running tests in another package: the operator's tests read `@arckive/core` from `dist/`.
- Run one test file with `corepack pnpm --filter <pkg> exec vitest run <path>`. Worker DB tests need Docker; worker RPC tests need `anvil` (Foundry).
- TypeScript ESM: relative imports end in `.js`; type-only imports use `import type`; env vars read with bracket notation (`process.env['X']`).
- Named error subclasses for domain failures; pino logs are object-first (`log.warn({ endpoint }, 'msg')`).
- Comments explain *why*, at the density of the surrounding code. Do not strip existing comments when moving code.
- Repository text is English. Commits are Conventional Commits and end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg
  ```
- Insight RPC: at most one HTTP request in flight across the whole pool; `CHUNK = 20` calls per request (1 for a `ws(s)` endpoint); rest window 5 s doubling to 60 s, cleared by the next answered request; `INSIGHTS_RPC_PACE = { startMs: 250, minMs: 50, maxMs: 8000 }` per endpoint.
- Insight endpoint URLs may carry API keys: logs name an endpoint as `<index>:<host>`, the metric label is the index only.
- `configHash` of a spec that uses none of the new fields must not change: the pinned value in `core/test/crd.test.ts` stays `2794d91436dcce97`.
- `_meta` keys are fixed for a schema's life; `address_indexes` joins them, and a schema bootstrapped before it existed counts as `'false'`.
- PostgreSQL 15+ (tests use `postgres:17-alpine`).
- Do not restart the k3d `arckive` cluster without the user's go-ahead (Task 10 asks first). Do not read or print Laya gate tokens. Do not load-test the Laya gate.

## Review Focus

1. **A batch answered with a short or garbled array** (HTTP 200, fewer items than asked): each unanswered call must fall through to the next endpoint without resting the first — pinned in Task 4 (`[]` answer test).
2. **A `network.rpc` with only `ws(s)` endpoints and no `insights.rpc`**: the default insight endpoint is a ws URL, which viem cannot batch; it must work one call per request rather than fail or fire 20 concurrent calls — pinned in Task 4 (`createRpcPool` ws chunk test).
3. **`insights.startBlock` negative on a young indexer** (ingest cursor smaller than `|n|`): the cursor must clamp to the ingest start, not go below it — pinned in Task 6.
4. **A reconcile that throws**: with the generation filter, a failed reconcile must not wait five minutes for the resync; the next watch event retries it — pinned in Task 7.
5. **A rotated service-account token**: the operator's own client must fetch the auth header per request, not once — pinned in Task 8.

---

### Task 1: `Live` means caught up

**Files:**
- Modify: `packages/worker/src/pipeline.ts:71-76` (`runOnce`, after `planRange`)
- Test: `packages/worker/test/pipeline.test.ts` (add one `it` inside `describe('pipeline')`)

**Interfaces:**
- Consumes: `runOnce(deps: PipelineDeps): Promise<boolean>`, `PhaseTracker` (`phase`, `set(phase, error?)`).
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Write the failing test**

Add inside `describe('pipeline', …)` in `packages/worker/test/pipeline.test.ts` (it uses the file's existing `deps`, `anvil`, `contractAddress`, `createStore`, `createMetrics`, `parseWorkerConfig`, `bootstrapIndexer`, `runOnce`, `PhaseTracker`):

```ts
  it('a Live worker one block behind stays Live; a range that cannot reach the head sets Backfilling', async () => {
    const tracker = new PhaseTracker();
    const seen: string[] = [];
    let head = 5n;
    const fake = {
      getBlock: async () => ({ number: head }),
      getLogs: async () => {
        seen.push(tracker.phase);
        return [];
      },
    } as unknown as PipelineDeps['client'];
    const cfg2 = parseWorkerConfig({
      indexerName: 'phase',
      network: { chainId: 31337, rpc: [anvil.url] },
      contracts: [{ name: 'emitter', address: contractAddress, abiPath: 'unused' }],
      polling: { batchBlocks: 2, intervalMs: 100 },
    });
    const d2: PipelineDeps = {
      ...deps, client: fake, cfg: cfg2, schema: 'idx_phase', store: createStore('idx_phase', deps.defs, 1_000_000),
      metrics: createMetrics('phase'), phase: tracker,
    };
    await bootstrapIndexer(d2);

    // cursor -1, head 5, span 2: blocks 0..1 cannot reach the head
    expect(await runOnce(d2)).toBe(true);
    expect(seen).toEqual(['Backfilling']);
    while (await runOnce(d2)) { /* 2..3, then 4..5 */ }
    expect(tracker.phase).toBe('Live');

    // the head moves one block: a live tail stays Live through its round
    seen.length = 0;
    head = 6n;
    expect(await runOnce(d2)).toBe(true);
    expect(seen).toEqual(['Live']);
    expect(tracker.phase).toBe('Live');

    // recovering from Degraded still reports Backfilling while it works
    seen.length = 0;
    tracker.set('Degraded', 'rpc down');
    head = 7n;
    expect(await runOnce(d2)).toBe(true);
    expect(seen).toEqual(['Backfilling']);
    expect(tracker.phase).toBe('Live');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/pipeline.test.ts -t "stays Live"`
Expected: FAIL — `expected [ 'Backfilling' ] to deeply equal [ 'Live' ]` (the live-tail round).

- [ ] **Step 3: Write minimal implementation**

In `packages/worker/src/pipeline.ts`, replace

```ts
  const range = planRange(cursor, finalized, deps.sizer?.size ?? cfg.polling.batchBlocks);
  if (!range) {
    phase.set('Live');
    return false;
  }
  phase.set('Backfilling');
```

with

```ts
  const range = planRange(cursor, finalized, deps.sizer?.size ?? cfg.polling.batchBlocks);
  if (!range) {
    phase.set('Live');
    return false;
  }
  // Backfilling means one round cannot reach the head. A live tail is a block
  // or two behind after every new block (~0.5 s on Arc); flipping to
  // Backfilling for each of those rounds paused the insight loop, which runs
  // only while ingest is Live, and made .status flap. A worker that is not
  // Live yet — starting, or recovering from Degraded — still reports
  // Backfilling while it works.
  if (range.toBlock < finalized || phase.phase !== 'Live') phase.set('Backfilling');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/pipeline.test.ts`
Expected: PASS (all pipeline tests).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/pipeline.ts packages/worker/test/pipeline.test.ts
git commit -m "fix(worker): a live tail stays Live instead of flipping to Backfilling every block

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 2: The new spec fields reach the worker

**Files:**
- Modify: `charts/arckive/crds/indexer.yaml` (`storage` and `insights` properties)
- Modify: `packages/core/src/crd.ts` (`IndexerSpecSchema.storage`, `IndexerSpecSchema.insights`, `renderWorkerConfig`)
- Modify: `packages/core/src/config.ts` (`WorkerConfigSchema.storage`, `WorkerConfigSchema.insights`)
- Modify: `install.yaml` (regenerated, never by hand)
- Test: `packages/core/test/crd.test.ts`, `packages/core/test/config.test.ts`, `packages/operator/test/crd-manifest.test.ts`

**Interfaces:**
- Produces (used by Tasks 3, 5, 6):
  - `IndexerSpec['storage']['addressIndexes']: boolean` (default `false`)
  - `IndexerSpec['insights']['rpc']?: string[]`, `IndexerSpec['insights']['startBlock']?: number`
  - `WorkerConfig['storage']['addressIndexes']?: boolean` — present only when `true`
  - `WorkerConfig['insights']['rpc']?: string[]`, `WorkerConfig['insights']['startBlock']?: number`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/crd.test.ts` (the file's `raw` is a valid minimal spec; `IndexerSpecSchema`, `renderWorkerConfig`, `configHash` are already imported):

```ts
describe('explorer fields', () => {
  it('storage.addressIndexes defaults to false and reaches the worker only when true', () => {
    const off = IndexerSpecSchema.parse(raw);
    expect(off.storage.addressIndexes).toBe(false);
    expect(renderWorkerConfig('x', off).storage).toEqual({ partitionBlocks: 2_000_000 });
    const on = IndexerSpecSchema.parse({ ...raw, storage: { ...raw.storage, addressIndexes: true } });
    expect(renderWorkerConfig('x', on).storage).toEqual({ partitionBlocks: 2_000_000, addressIndexes: true });
  });

  it('insights.rpc and insights.startBlock reach the worker; absent, they are absent', () => {
    const insights = { laya: { url: 'https://gate.example' } };
    const plain = renderWorkerConfig('x', IndexerSpecSchema.parse({ ...raw, insights }));
    expect(plain.insights).toEqual({ laya: { url: 'https://gate.example' } });
    const full = renderWorkerConfig('x', IndexerSpecSchema.parse({
      ...raw,
      insights: { ...insights, rpc: ['https://a.example', 'https://b.example'], startBlock: -2000 },
    }));
    expect(full.insights).toEqual({
      laya: { url: 'https://gate.example' }, rpc: ['https://a.example', 'https://b.example'], startBlock: -2000,
    });
  });

  it('insights.rpc refuses ws endpoints, an empty list and more than eight', () => {
    const at = (rpc: string[]) => IndexerSpecSchema.safeParse({ ...raw, insights: { laya: { url: 'https://g' }, rpc } }).success;
    expect(at(['wss://a.example'])).toBe(false);
    expect(at([])).toBe(false);
    expect(at(Array.from({ length: 9 }, (_, i) => `https://e${i}.example`))).toBe(false);
    expect(at(Array.from({ length: 8 }, (_, i) => `https://e${i}.example`))).toBe(true);
  });

  it('a spec without the new fields keeps its config hash', () => {
    expect(configHash(renderWorkerConfig('demo', IndexerSpecSchema.parse(raw)))).toBe('2794d91436dcce97');
  });
});
```

Append to `packages/core/test/config.test.ts` (it imports `parseWorkerConfig` and defines the minimal valid config `VALID`):

```ts
describe('explorer fields in the worker config', () => {
  it('accepts addressIndexes, insights.rpc and insights.startBlock', () => {
    const cfg = parseWorkerConfig({
      ...VALID,
      storage: { partitionBlocks: 50_000, addressIndexes: true },
      insights: { laya: { url: 'https://g.example' }, rpc: ['https://a.example'], startBlock: 100 },
    });
    expect(cfg.storage.addressIndexes).toBe(true);
    expect(cfg.insights?.rpc).toEqual(['https://a.example']);
    expect(cfg.insights?.startBlock).toBe(100);
  });

  it('refuses a ws insights endpoint', () => {
    expect(() => parseWorkerConfig({
      ...VALID, insights: { laya: { url: 'https://g.example' }, rpc: ['wss://a.example'] },
    })).toThrow();
  });
});
```

Append inside the CRD describe of `packages/operator/test/crd-manifest.test.ts` (next to the `storage.partitionBlocks` test, reusing its `v`):

```ts
  it('storage.addressIndexes and insights.rpc/startBlock match zod', () => {
    const spec = v.schema.openAPIV3Schema.properties.spec.properties as Record<
      string, { properties: Record<string, Record<string, unknown>> }
    >;
    expect(spec['storage']!.properties['addressIndexes']).toMatchObject({ type: 'boolean', default: false });
    expect(spec['insights']!.properties['rpc']).toMatchObject({
      type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^https?://' },
    });
    expect(spec['insights']!.properties['startBlock']).toMatchObject({ type: 'integer' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter @arckive/core exec vitest run test/crd.test.ts test/config.test.ts`
Expected: FAIL — `addressIndexes` undefined, `rpc`/`startBlock` stripped, ws accepted.

- [ ] **Step 3: Implement — zod (spec)**

In `packages/core/src/crd.ts`, `IndexerSpecSchema`:

```ts
  storage: z.object({
    mode: z.literal('External'),
    external: z.object({
      dsnSecretRef: z.object({
        name: z.string().min(1),
        key: z.string().min(1).default('url'),
      }),
    }),
    partitionBlocks: z.number().int().min(10_000).default(2_000_000),
    // Index every address param as (<p>_id, block_number, log_index): "the
    // latest rows of this address" reads an index backwards instead of
    // sorting every row of a busy address. Fixed when the schema is created.
    addressIndexes: z.boolean().default(false),
  }),
```

and

```ts
  insights: z
    .object({
      laya: z.object({
        url: z.string().regex(/^https?:\/\//i, 'insights.laya.url must be http(s)://'),
        headerSecretRef: z
          .object({ name: z.string().min(1), key: z.string().min(1).default('header') })
          .optional(),
      }),
      // Endpoints for insight reads only, in priority order. http(s) only:
      // insight reads go out as JSON-RPC batches. Absent: the last http(s)
      // entry of network.rpc.
      rpc: z
        .array(z.string().regex(/^https?:\/\//i, 'insights.rpc entries must be http(s)://'))
        .min(1)
        .max(8)
        .optional(),
      // First block that gets lanes. Omitted: the indexer's own start; >= 0:
      // that block; negative: that many blocks before the head when the
      // insight loop first runs. Takes effect once per schema.
      startBlock: z.number().int().optional(),
    })
    .optional(),
```

In `renderWorkerConfig`, replace the `storage` and `insights` lines with:

```ts
    // New fields travel only when set, so a spec that does not use them keeps
    // its config hash — and its running worker.
    storage: {
      partitionBlocks: spec.storage.partitionBlocks,
      ...(spec.storage.addressIndexes ? { addressIndexes: true } : {}),
    },
    ...(spec.insights
      ? {
          insights: {
            laya: { url: spec.insights.laya.url },
            ...(spec.insights.rpc ? { rpc: spec.insights.rpc } : {}),
            ...(spec.insights.startBlock !== undefined ? { startBlock: spec.insights.startBlock } : {}),
          },
        }
      : {}),
```

- [ ] **Step 4: Implement — zod (worker config)**

In `packages/core/src/config.ts`, `WorkerConfigSchema`:

```ts
  storage: z
    .object({
      partitionBlocks: z.number().int().min(10_000).default(2_000_000),
      // absent = false; see IndexerSpecSchema.storage.addressIndexes
      addressIndexes: z.boolean().optional(),
    })
    .default({}),
  // Laya insights (optional): where the model gate is. The header that
  // authenticates to it is a secret and arrives as INSIGHTS_HEADER, never here.
  insights: z
    .object({
      laya: z.object({
        url: z.string().regex(/^https?:\/\//i, 'insights.laya.url must be http(s)://'),
      }),
      rpc: z
        .array(z.string().regex(/^https?:\/\//i, 'insights.rpc entries must be http(s)://'))
        .min(1)
        .max(8)
        .optional(),
      startBlock: z.number().int().optional(),
    })
    .optional(),
```

- [ ] **Step 5: Implement — CRD**

In `charts/arckive/crds/indexer.yaml`, under `storage.properties`, after `partitionBlocks`:

```yaml
                    addressIndexes:
                      type: boolean
                      default: false
                      description: "Index every address param as (<p>_id, block_number, log_index) so the latest rows of an address come from an index; fixed when the schema is created"
```

Under `insights.properties`, after `laya`:

```yaml
                    rpc:
                      type: array
                      minItems: 1
                      maxItems: 8
                      items:
                        type: string
                        pattern: '^https?://'
                      description: "http(s) endpoints for insight reads only, in priority order; default: the last http(s) entry of network.rpc"
                    startBlock:
                      type: integer
                      description: "first block that gets lanes: omitted = the indexer's start, >= 0 = that block, negative = that many blocks before the head when insights first run; takes effect once per schema"
```

- [ ] **Step 6: Regenerate install.yaml and run the tests**

Run:
```bash
corepack pnpm -r build
scripts/build-install.sh
git diff --stat install.yaml
corepack pnpm --filter @arckive/core exec vitest run
corepack pnpm --filter @arckive/operator exec vitest run
```
Expected: `install.yaml` changed only in the CRD block; all core and operator tests PASS, including the pinned hash.

- [ ] **Step 7: Commit**

```bash
git add charts/arckive/crds/indexer.yaml packages/core/src/crd.ts packages/core/src/config.ts install.yaml \
  packages/core/test/crd.test.ts packages/core/test/config.test.ts packages/operator/test/crd-manifest.test.ts
git commit -m "feat(core): insights.rpc, insights.startBlock and storage.addressIndexes spec fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 3: Address indexes

**Files:**
- Modify: `packages/core/src/ddl.ts` (`buildEventTable`)
- Modify: `packages/worker/src/db.ts` (`assertLayout`, `bootstrap`, `Store`, `createStore`)
- Modify: `packages/worker/src/pipeline.ts` (`bootstrapIndexer` meta)
- Modify: `packages/worker/src/main.ts:72` (`createStore` call)
- Test: `packages/core/test/ddl.test.ts`, `packages/worker/test/db.test.ts`

**Interfaces:**
- Consumes: `WorkerConfig['storage']['addressIndexes']?: boolean` (Task 2).
- Produces:
  - `buildEventTable(schema: string, def: EventDef, opts?: { addressIndexes?: boolean }): TableSpec`
  - `createStore(schema, defs, partitionBlocks, compactor?, addressIndexes = false): Store`; `Store.addressIndexes: boolean`
  - `_meta` key `address_indexes` = `'true' | 'false'`, written by `bootstrapIndexer`
  - `LEGACY_META: Readonly<Record<string, string>>` exported from `worker/src/db.ts`

- [ ] **Step 1: Write the failing core tests**

Append to `packages/core/test/ddl.test.ts` (it imports `buildEventTable`, `extractEventDefs`, `NamingError`, and defines `ADDR`, `TRANSFER_ABI`):

```ts
describe('buildEventTable addressIndexes', () => {
  const transfer = extractEventDefs('usdc', ADDR, TRANSFER_ABI)[0]!;

  it('off: one single-column index per indexed param, as before', () => {
    const s = buildEventTable('idx_x', transfer).statements;
    expect(s).toContain('CREATE INDEX IF NOT EXISTS "usdc_transfer_from_id_idx" ON "idx_x"."usdc_transfer" ("from_id")');
    expect(s).toContain('CREATE INDEX IF NOT EXISTS "usdc_transfer_to_id_idx" ON "idx_x"."usdc_transfer" ("to_id")');
  });

  it('on: every address param by (id, block_number, log_index), under the same name', () => {
    const s = buildEventTable('idx_x', transfer, { addressIndexes: true }).statements;
    expect(s).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_from_id_idx" ON "idx_x"."usdc_transfer" ("from_id", block_number, log_index)',
    );
    expect(s).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_to_id_idx" ON "idx_x"."usdc_transfer" ("to_id", block_number, log_index)',
    );
    expect(s.some((x) => x.endsWith('("from_id")'))).toBe(false);
  });

  it('on: a non-indexed address param gets one too; an indexed non-address param keeps its own', () => {
    const init = extractEventDefs('pm', ADDR, [{
      type: 'event', name: 'Initialize',
      inputs: [
        { name: 'id', type: 'bytes32', indexed: true },
        { name: 'hooks', type: 'address', indexed: false },
      ],
    }])[0]!;
    const s = buildEventTable('idx_x', init, { addressIndexes: true }).statements;
    expect(s).toContain(
      'CREATE INDEX IF NOT EXISTS "pm_initialize_hooks_id_idx" ON "idx_x"."pm_initialize" ("hooks_id", block_number, log_index)',
    );
    expect(s).toContain('CREATE INDEX IF NOT EXISTS "pm_initialize_id_idx" ON "idx_x"."pm_initialize" ("id")');
  });

  it('on: an index name over 63 bytes raises NamingError', () => {
    // table name 49 bytes passes the partition check (+ "_p999999"); the index name is 66
    const long = extractEventDefs('c'.repeat(40), ADDR, [{
      type: 'event', name: 'Transfer',
      inputs: [{ name: 'recipient', type: 'address', indexed: false }],
    }])[0]!;
    expect(() => buildEventTable('idx_x', long)).not.toThrow();
    expect(() => buildEventTable('idx_x', long, { addressIndexes: true })).toThrow(NamingError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm --filter @arckive/core exec vitest run test/ddl.test.ts`
Expected: FAIL on the three `on:` tests (no composite statements).

- [ ] **Step 3: Implement in core**

In `packages/core/src/ddl.ts`, change the signature and the index lines of `buildEventTable`:

```ts
export interface EventTableOptions {
  // storage.addressIndexes: see the index comment below
  addressIndexes?: boolean;
}

export function buildEventTable(schema: string, def: EventDef, opts: EventTableOptions = {}): TableSpec {
```

and replace

```ts
    ...params
      .filter((c) => c.indexed)
      .map((c) => `CREATE INDEX IF NOT EXISTS ${q(`${def.tableName}_${c.name}_idx`)} ON ${t} (${q(c.name)})`),
```

with

```ts
    ...params
      .filter((c) => c.indexed || (opts.addressIndexes === true && c.abiType === 'address'))
      .map((c) => {
        const name = `${def.tableName}_${c.name}_idx`;
        // An address is looked up as "its latest rows". With block_number and
        // log_index after the id, each partition's index is read backwards and
        // pages by keyset; a single-column index finds every row of a busy
        // address and sorts them. Same name as the single-column index it
        // replaces, so a schema has one or the other (_meta address_indexes).
        if (opts.addressIndexes === true && c.abiType === 'address') {
          return `CREATE INDEX IF NOT EXISTS ${q(assertPgIdentifier(name))} ON ${t} (${q(c.name)}, block_number, log_index)`;
        }
        return `CREATE INDEX IF NOT EXISTS ${q(name)} ON ${t} (${q(c.name)})`;
      }),
```

Export `EventTableOptions` from `packages/core/src/index.ts` if `ddl.ts` exports are listed there individually (check `grep -n "ddl" packages/core/src/index.ts`; if it is `export * from './ddl.js'`, nothing to do).

- [ ] **Step 4: Run core tests**

Run: `corepack pnpm --filter @arckive/core exec vitest run test/ddl.test.ts && corepack pnpm -r build`
Expected: PASS; build succeeds.

- [ ] **Step 5: Write the failing worker DB tests**

Add inside the main `describe` of `packages/worker/test/db.test.ts` (it has `pool`, `defs`, `META`, `row()`, `createStore`, `bootstrap`, `buildControlTables`, `initCursor`, `commitBatch`, `LayoutError` in scope; import `commitBatch`/`LayoutError` from `../src/db.js` if they are not imported yet):

```ts
  describe('address indexes', () => {
    const S = 'idx_addr';
    const indexDefs = async (table: string): Promise<string[]> =>
      (await pool.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [S, table]))
        .rows.map((r: { indexdef: string }) => r.indexdef);
    const fresh = async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
      const st = createStore(S, defs, 1000, undefined, true);
      await bootstrap(pool, S, buildControlTables(S), [...st.tables.values()], { ...META, address_indexes: 'true' });
      await initCursor(pool, S, 9n);
      return st;
    };

    it('are on the parent and on every partition, including ones created later', async () => {
      const st = await fresh();
      await commitBatch(pool, st, [row(10, 0)], [], 10n); // partition 0
      await commitBatch(pool, st, [row(2500, 0)], [], 2500n); // partition 2, created after bootstrap
      for (const table of ['usdc_transfer', 'usdc_transfer_p0', 'usdc_transfer_p2']) {
        const idx = await indexDefs(table);
        expect(idx.some((d) => d.includes('(from_id, block_number, log_index)'))).toBe(true);
        expect(idx.some((d) => d.includes('(to_id, block_number, log_index)'))).toBe(true);
        expect(idx.some((d) => d.endsWith('(from_id)'))).toBe(false);
      }
    });

    it('give "latest 25 for this address" in index order, without a sort', async () => {
      const st = await fresh();
      await commitBatch(pool, st, Array.from({ length: 300 }, (_, i) => row(10 + i, 0)), [], 400n);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL enable_seqscan = off');
        await c.query('SET LOCAL enable_sort = off');
        const plan = JSON.stringify((await c.query(
          `EXPLAIN (FORMAT JSON) SELECT block_number, log_index FROM ${S}.usdc_transfer
           WHERE from_id = (SELECT id FROM ${S}._addresses WHERE address = $1)
           ORDER BY block_number DESC, log_index DESC LIMIT 25`,
          [hex('0x' + '1'.repeat(40))],
        )).rows[0]['QUERY PLAN']);
        await c.query('ROLLBACK');
        expect(plan).toContain('"Scan Direction":"Backward"');
        expect(plan).toContain('from_id_block_number_log_index_idx');
        expect(plan).not.toContain('"Node Type":"Sort"');
      } finally {
        c.release();
      }
    });

    it('address_indexes is fixed for the schema; a schema from before the key counts as false', async () => {
      // beforeEach bootstrapped SCHEMA with META, which has no address_indexes:
      // the shape of a schema created before the key existed
      const on = createStore(SCHEMA, defs, 1000, undefined, true);
      await expect(
        bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...on.tables.values()], { ...META, address_indexes: 'true' }),
      ).rejects.toBeInstanceOf(LayoutError);
      await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], { ...META, address_indexes: 'false' });
      const meta = await pool.query(`SELECT value FROM ${SCHEMA}._meta WHERE key = 'address_indexes'`);
      expect(meta.rows).toEqual([{ value: 'false' }]);
      // and the other way round: created with true, asked for false
      await fresh();
      const off = createStore(S, defs, 1000);
      await expect(
        bootstrap(pool, S, buildControlTables(S), [...off.tables.values()], { ...META, address_indexes: 'false' }),
      ).rejects.toBeInstanceOf(LayoutError);
    });
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/db.test.ts -t "address indexes"`
Expected: FAIL — `createStore` ignores the fifth argument (single-column indexes), and the legacy schema accepts `'true'`.

- [ ] **Step 7: Implement in the worker**

In `packages/worker/src/db.ts`:

1. `assertLayout` returns whether the schema already existed — change its signature and the early return:

```ts
// Whether the schema already existed: a fresh one has no _cursor yet.
async function assertLayout(client: pg.PoolClient, schema: string): Promise<boolean> {
  const r = await client.query(
    'SELECT to_regclass($1) IS NOT NULL AS has_cursor, to_regclass($2) IS NOT NULL AS has_meta',
    [`${q(schema)}._cursor`, `${q(schema)}._meta`],
  );
  if (!r.rows[0].has_cursor) return false; // a fresh schema
  const layout: string | undefined = r.rows[0].has_meta
    ? (await client.query(`SELECT value FROM ${q(schema)}._meta WHERE key = 'layout'`)).rows[0]?.value
    : undefined;
  if (layout !== STORAGE_LAYOUT) {
    throw new LayoutError(
      `schema ${schema} uses storage layout ${layout ?? '1'}; drop the schema or rename the Indexer to re-index`,
    );
  }
  return true;
}
```

2. Above `bootstrap`, add:

```ts
// _meta keys added after layout 2 shipped, with the value a schema
// bootstrapped before them has in effect. A schema created without address
// indexes has none, so asking it for them is a different value — refused
// like any other.
export const LEGACY_META: Readonly<Record<string, string>> = { address_indexes: 'false' };
```

3. In `bootstrap`, replace the body between `await client.query('BEGIN');` and `await client.query('COMMIT');` with:

```ts
    const existed = await assertLayout(client, schema);
    for (const s of controlStatements) await client.query(s);
    // _meta before the tables: a refused value must build nothing first —
    // CREATE INDEX on a partitioned table cannot run CONCURRENTLY, so building
    // address indexes over existing rows would hold ingest for its duration.
    for (const [key, value] of Object.entries({ ...meta, layout: STORAGE_LAYOUT })) {
      const first = existed && Object.hasOwn(LEGACY_META, key) ? LEGACY_META[key]! : value;
      await client.query(
        `INSERT INTO ${q(schema)}._meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, first],
      );
      const stored: string = (await client.query(`SELECT value FROM ${q(schema)}._meta WHERE key = $1`, [key])).rows[0].value;
      if (stored !== value) {
        throw new LayoutError(
          `schema ${schema} has ${key} = ${stored}, this Indexer has ${value}; drop the schema or rename the Indexer to re-index`,
        );
      }
    }
    for (const t of tables) for (const s of t.statements) await client.query(s);
```

4. `Store` and `createStore`:

```ts
export interface Store {
  schema: string;
  tables: ReadonlyMap<string, TableSpec>; // event tables by name
  partitions: Partitions;
  addressIndexes: boolean; // storage.addressIndexes, recorded in _meta
}

export function createStore(
  schema: string, defs: EventDef[], partitionBlocks: number, compactor?: Pick<Compactor, 'enqueue'>,
  addressIndexes = false,
): Store {
  const specs = defs.map((d) => buildEventTable(schema, d, { addressIndexes }));
  return {
    schema,
    tables: new Map(specs.map((s) => [s.table, s])),
    partitions: new Partitions(
      schema,
      BigInt(partitionBlocks),
      compactor ? (table, n) => compactor.enqueue(schema, partitionName(table, n)) : undefined,
    ),
    addressIndexes,
  };
}
```

In `packages/worker/src/pipeline.ts` `bootstrapIndexer`, add the key to the meta object:

```ts
    {
      ...contractMeta(deps.defs),
      partition_blocks: String(deps.store.partitions.size),
      address_indexes: String(deps.store.addressIndexes),
    },
```

In `packages/worker/src/main.ts`, the `store:` line becomes:

```ts
    store: createStore(
      schemaName(cfg.indexerName), defs, cfg.storage.partitionBlocks, compactor, cfg.storage.addressIndexes ?? false,
    ),
```

- [ ] **Step 8: Run the worker DB and pipeline tests**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/db.test.ts test/pipeline.test.ts test/insights.test.ts test/deadletter.test.ts`
Expected: PASS, including the existing "bootstrap is idempotent" test (its `META` has no `address_indexes`, so no legacy row is written).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/ddl.ts packages/core/src/index.ts packages/core/test/ddl.test.ts \
  packages/worker/src/db.ts packages/worker/src/pipeline.ts packages/worker/src/main.ts packages/worker/test/db.test.ts
git commit -m "feat: storage.addressIndexes — (id, block_number, log_index) per address param, fixed in _meta

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 4: The insight RPC pool

**Files:**
- Create: `packages/worker/src/rpcpool.ts`
- Test: `packages/worker/test/rpcpool.test.ts`

**Interfaces:**
- Consumes: `Pacer`, `isRateLimited`, `PaceLimits` from `./pacer.js`.
- Produces (used by Task 5):
  - `CHUNK = 20`, `REST_START_MS = 5_000`, `REST_MAX_MS = 60_000`
  - `INSIGHTS_RPC_PACE: PaceLimits = { startMs: 250, minMs: 50, maxMs: 8000 }` (moves here from `txcontext.ts` in Task 5)
  - `type Call<T> = (client: PublicClient) => Promise<T>`
  - `type RequestOutcome = 'ok' | 'rate_limited' | 'failed'`
  - `interface PoolEndpoint { url: string; client: PublicClient; shared: boolean; chunk: number }`
  - `interface RpcPoolOptions { pace: PaceLimits; now?: () => number; sleep?: (ms: number) => Promise<void>; onRequest?: (endpoint: number, outcome: RequestOutcome) => void; log?: Pick<Logger, 'warn'> }`
  - `class RpcPool { constructor(endpoints: readonly PoolEndpoint[], opts: RpcPoolOptions); get endpoints(): ReadonlyArray<{ label: string; chunk: number; shared: boolean }>; all<T>(calls: readonly Call<T>[]): Promise<PromiseSettledResult<T>[]>; backOffShared(): void }`
  - `createRpcPool(urls: readonly string[], ingestUrls: readonly string[], opts: RpcPoolOptions): RpcPool`
  - `checkPoolChain(urls: readonly string[], chainId: number, log: Pick<Logger, 'error'>, probe?: (url: string) => Promise<number>): Promise<string[]>`
  - `endpointLabel(index: number, url: string): string`
  - `isTooLarge(err: unknown): boolean`, `isTransportFailure(err: unknown): boolean`

- [ ] **Step 1: Write the failing unit tests (fake clients)**

Create `packages/worker/test/rpcpool.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import { HttpRequestError, type PublicClient } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK, RpcPool, checkPoolChain, createRpcPool, endpointLabel, type Call, type PoolEndpoint, type RequestOutcome,
} from '../src/rpcpool.js';

const NO_PACE = { startMs: 0, minMs: 0, maxMs: 0 };
const limited = () => new HttpRequestError({ url: 'http://x', status: 429 });
const down = () => new HttpRequestError({ url: 'http://x', status: 503 });
const tooLarge = () => Object.assign(new Error('response body exceeded the size limit'), { name: 'ResponseBodyTooLargeError' });
const refused = () => new Error('Archive requests require a personal token');

// A fake endpoint: its client is just a name the calls read.
const ep = (name: string, shared = false, chunk = CHUNK): PoolEndpoint =>
  ({ url: `https://${name}.example/key`, client: { name } as unknown as PublicClient, shared, chunk });
const nameOf = (c: PublicClient) => (c as unknown as { name: string }).name;

function harness(endpoints: PoolEndpoint[], start = 0) {
  const clock = { t: start };
  const requests: Array<[number, RequestOutcome]> = [];
  const pool = new RpcPool(endpoints, {
    pace: NO_PACE, now: () => clock.t, sleep: async () => {}, onRequest: (e, o) => requests.push([e, o]),
  });
  return { pool, clock, requests };
}

describe('RpcPool', () => {
  it('cuts calls into chunks of 20, one request each, results in input order', async () => {
    const { pool, requests } = harness([ep('a')]);
    const seenAt: number[] = [];
    const calls: Call<number>[] = Array.from({ length: 41 }, (_, i) => async () => {
      seenAt.push(requests.length); // requests finished before this call started
      return i;
    });
    const out = await pool.all(calls);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : -1))).toEqual([...Array(41).keys()]);
    expect(requests).toEqual([[0, 'ok'], [0, 'ok'], [0, 'ok']]);
    expect([0, 1, 2].map((k) => seenAt.filter((s) => s === k).length)).toEqual([20, 20, 1]);
  });

  it('never has two requests in flight, even when callers overlap', async () => {
    const { pool } = harness([ep('a')]);
    const log: string[] = [];
    const slow = (tag: string): Call<void> => async () => {
      log.push(`${tag}+`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`${tag}-`);
    };
    await Promise.all([pool.all([slow('A')]), pool.all([slow('B')])]);
    expect(log).toEqual(['A+', 'A-', 'B+', 'B-']);
  });

  it('a rate-limited request rests its endpoint and its calls go to the next one', async () => {
    const { pool, requests, clock } = harness([ep('a'), ep('b')]);
    const call: Call<string> = async (c) => {
      if (nameOf(c) === 'a') throw limited();
      return nameOf(c);
    };
    const first = await pool.all([call, call]);
    expect(first.map((r) => r.status === 'fulfilled' && r.value)).toEqual(['b', 'b']);
    expect(requests).toEqual([[0, 'rate_limited'], [1, 'ok']]);
    // a rests 5 s: the next round starts at b
    clock.t += 4_000;
    await pool.all([call]);
    expect(requests.at(-1)).toEqual([1, 'ok']);
    // after the rest a is asked first again
    clock.t += 1_001;
    await pool.all([call]);
    expect(requests.at(-2)).toEqual([0, 'rate_limited']);
  });

  it('a refusal (any other JSON-RPC answer) moves the call on without resting the endpoint', async () => {
    const { pool, requests } = harness([ep('a'), ep('b')]);
    const out = await pool.all<string>([
      async (c) => { if (nameOf(c) === 'a') throw refused(); return nameOf(c); },
      async (c) => nameOf(c),
    ]);
    expect(out.map((r) => r.status === 'fulfilled' && r.value)).toEqual(['b', 'a']);
    expect(requests).toEqual([[0, 'failed'], [1, 'ok']]);
    await pool.all([async (c) => nameOf(c)]);
    expect(requests.at(-1)).toEqual([0, 'ok']); // a was not resting
  });

  it('tries each endpoint once per chunk, then rejects with the last error', async () => {
    const { pool, requests } = harness([ep('a'), ep('b')]);
    const [r] = await pool.all([async () => { throw refused(); }]);
    expect(r!.status).toBe('rejected');
    expect((r as PromiseRejectedResult).reason.message).toMatch(/personal token/);
    expect(requests.map(([e]) => e)).toEqual([0, 1]);
  });

  it('rest windows double per failure up to 60 s and clear on the next answer', async () => {
    const { pool, clock, requests } = harness([ep('a'), ep('b')]);
    let aDown = true;
    const call: Call<string> = async (c) => {
      if (nameOf(c) === 'a' && aDown) throw down();
      return nameOf(c);
    };
    // which endpoint a one-call round asks first
    const firstAsked = async () => {
      requests.length = 0;
      await pool.all([call]);
      return requests[0]![0];
    };
    for (const rest of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      expect(await firstAsked()).toBe(0); // a is asked, fails, rests `rest`
      clock.t += rest - 1;
      expect(await firstAsked()).toBe(1); // still resting: b goes first
      clock.t += 1;
    }
    aDown = false;
    expect(await firstAsked()).toBe(0); // a answers: its rest is cleared
    aDown = true;
    expect(await firstAsked()).toBe(0); // fails again: back to the first rest, 5 s
    clock.t += 5_000;
    expect(await firstAsked()).toBe(0);
  });

  it('when every endpoint rests, asks the one whose rest ends first', async () => {
    const { pool, clock, requests } = harness([ep('a'), ep('b')]);
    const failing = new Set(['a']);
    const call: Call<string> = async (c) => {
      if (failing.has(nameOf(c))) throw down();
      return nameOf(c);
    };
    await pool.all([call]); // t=0: a fails, rests until 5 s
    clock.t = 5_000;
    await pool.all([call]); // a fails again, rests until 15 s
    failing.add('b');
    clock.t = 6_000;
    await pool.all([call]); // b fails, rests until 11 s; a is asked anyway, rests until 26 s
    clock.t = 7_000;
    requests.length = 0;
    await pool.all([call]);
    expect(requests.map(([e]) => e)).toEqual([1, 0]); // b's rest ends first
  });

  it('a response too large is halved on the same endpoint; one call alone too large fails', async () => {
    const { pool, requests } = harness([ep('a'), ep('b')]);
    // the calls of one request start in the same tick: they share `open`
    let open: { size: number } | null = null;
    const calls: Call<number>[] = Array.from({ length: 8 }, (_, i) => async () => {
      const req = open ?? (open = { size: 0 });
      req.size++;
      queueMicrotask(() => { open = null; });
      await null; // every call of the request has counted itself by now
      if (i === 7) throw tooLarge(); // too large even alone
      if (req.size > 2) throw tooLarge(); // a request of more than two calls is too large
      return i;
    });
    const out = await pool.all(calls);
    expect(out.slice(0, 7).map((r) => r.status)).toEqual(Array(7).fill('fulfilled'));
    expect(out[7]!.status).toBe('rejected');
    expect(requests.every(([e]) => e === 0)).toBe(true); // halving stays on the endpoint
  });

  it('backOffShared slows only the endpoints ingest also uses', async () => {
    const waits: number[] = [];
    const pool = new RpcPool([ep('a', true), ep('b', false)], {
      pace: { startMs: 100, minMs: 100, maxMs: 1000 }, now: () => 0, sleep: async (ms) => { waits.push(ms); },
    });
    pool.backOffShared();
    await pool.all([async (c) => nameOf(c)]); // a (shared) waits its doubled interval
    expect(waits).toEqual([200]);
  });
});
```

Then the factory and chain-id tests, plus a real HTTP test that shows viem batching:

```ts
describe('endpointLabel', () => {
  it('names an endpoint by index and host, never its path', () => {
    expect(endpointLabel(2, 'https://rpc.example.com/v1/SECRETKEY')).toBe('2:rpc.example.com');
    expect(endpointLabel(0, 'not a url')).toBe('0:?');
  });
});

describe('createRpcPool', () => {
  it('batches http endpoints by 20, takes ws ones one call per request, and marks ingest\'s as shared', () => {
    const pool = createRpcPool(
      ['https://a.example', 'wss://b.example', 'https://c.example/'],
      ['https://c.example', 'https://ingest.example'],
      { pace: NO_PACE },
    );
    expect(pool.endpoints).toEqual([
      { label: '0:a.example', chunk: 20, shared: false },
      { label: '1:b.example', chunk: 1, shared: false },
      { label: '2:c.example', chunk: 20, shared: true },
    ]);
  });
});

describe('checkPoolChain', () => {
  it('drops an endpoint on another chain and keeps one that does not answer', async () => {
    const errors: unknown[] = [];
    const kept = await checkPoolChain(
      ['https://a.example', 'https://b.example', 'https://c.example'], 5042,
      { error: (o: unknown) => errors.push(o) },
      async (url) => {
        if (url.includes('b.')) return 1;
        if (url.includes('c.')) throw new Error('down');
        return 5042;
      },
    );
    expect(kept).toEqual(['https://a.example', 'https://c.example']);
    expect(errors).toHaveLength(1);
  });
});

describe('RpcPool over HTTP (viem batching)', () => {
  const servers: Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  // Each request body is recorded; `answer` decides the reply.
  async function rpcServer(answer: (body: Array<{ id: number }>) => { status: number; json?: unknown }) {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data);
        bodies.push(body);
        const { status, json } = answer(Array.isArray(body) ? body : [body]);
        res.writeHead(status, { 'content-type': 'application/json' }).end(json === undefined ? '' : JSON.stringify(json));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies };
  }
  const ok = (body: Array<{ id: number }>) => ({
    status: 200, json: body.map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x' })),
  });
  const code = (i: number): Call<unknown> => (c) => c.getCode({ address: `0x${i.toString(16).padStart(40, '0')}` });

  it('sends 20 calls as one JSON-RPC array', async () => {
    const a = await rpcServer(ok);
    const pool = createRpcPool([a.url], [], { pace: NO_PACE });
    const out = await pool.all(Array.from({ length: 20 }, (_, i) => code(i)));
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(a.bodies).toHaveLength(1);
    expect((a.bodies[0] as unknown[]).length).toBe(20);
  });

  it('an HTTP 429 sends the batch to the next endpoint once, with no transport retry', async () => {
    const a = await rpcServer(() => ({ status: 429 }));
    const b = await rpcServer(ok);
    const pool = createRpcPool([a.url, b.url], [], { pace: NO_PACE });
    const out = await pool.all(Array.from({ length: 5 }, (_, i) => code(i)));
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies).toHaveLength(1);
    await pool.all([code(9)]); // a rests
    expect(a.bodies).toHaveLength(1);
  });

  it('a batch answered with an empty array moves every call on, without resting the endpoint', async () => {
    const a = await rpcServer(() => ({ status: 200, json: [] }));
    const b = await rpcServer(ok);
    const pool = createRpcPool([a.url, b.url], [], { pace: NO_PACE });
    const out = await pool.all([code(1), code(2)]);
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
    await pool.all([code(3)]);
    expect(a.bodies).toHaveLength(2); // asked again: not resting
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/rpcpool.test.ts`
Expected: FAIL — `Cannot find module '../src/rpcpool.js'`.

- [ ] **Step 3: Implement `packages/worker/src/rpcpool.ts`**

```ts
import type { Logger } from 'pino';
import { HttpRequestError, TimeoutError, createPublicClient, http, webSocket, type PublicClient } from 'viem';
import { Pacer, isRateLimited, type PaceLimits } from './pacer.js';

// The insight loop's RPC reads, ported from Arc Radar's pool
// (radar/radar/rpc.py), which keeps up with Arc mainnet on the same public
// endpoints: calls go out as JSON-RPC batches of up to 20, one request at a
// time, to endpoints tried in config order. Order is priority, not load
// balancing (like ingest's rank: false). An endpoint that rate-limits or
// fails rests while the others carry the load; a call one endpoint will not
// answer — beamrpc refuses blocks older than ~2 h, a lagging node has not
// seen a block yet — is asked of the next one without resting the first.

export const CHUNK = 20;
export const REST_START_MS = 5_000;
export const REST_MAX_MS = 60_000;

// Per endpoint, between requests: four a second to start, as fast as twenty a
// second on an endpoint that takes it, as slow as one per 8 s on one that
// does not (see pacer.ts). A request is one batch of up to CHUNK calls.
export const INSIGHTS_RPC_PACE: PaceLimits = { startMs: 250, minMs: 50, maxMs: 8000 };

export type Call<T> = (client: PublicClient) => Promise<T>;
export type RequestOutcome = 'ok' | 'rate_limited' | 'failed';

export interface PoolEndpoint {
  url: string;
  client: PublicClient;
  shared: boolean; // ingest queries it too (network.rpc)
  chunk: number; // calls per request: CHUNK for http, 1 for ws (no batching)
}

export interface RpcPoolOptions {
  pace: PaceLimits;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (endpoint: number, outcome: RequestOutcome) => void;
  log?: Pick<Logger, 'warn'>;
}

// URLs may carry an API key in the path or query: an endpoint is named by its
// place in the pool and its host only.
export function endpointLabel(index: number, url: string): string {
  try {
    return `${index}:${new URL(url).host}`;
  } catch {
    return `${index}:?`;
  }
}

function walk(err: unknown, test: (e: unknown) => boolean): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    if (test(e)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// viem refuses a response body over its size limit (10 MiB): a batch of busy
// blocks' receipts can pass it, and half the batch will not.
export function isTooLarge(err: unknown): boolean {
  return walk(err, (e) => (e as { name?: unknown }).name === 'ResponseBodyTooLargeError');
}

// The endpoint did not answer at all: a timeout, a dropped connection, an
// HTTP error status. A JSON-RPC error inside a 200 is an answer, not this.
export function isTransportFailure(err: unknown): boolean {
  return walk(err, (e) => (e instanceof HttpRequestError && e.status !== 429) || e instanceof TimeoutError);
}

class Slot {
  failures = 0;
  restUntil = 0;
  constructor(
    readonly index: number,
    readonly label: string,
    readonly client: PublicClient,
    readonly shared: boolean,
    readonly chunk: number,
    readonly pacer: Pacer,
  ) {}
}

export class RpcPool {
  readonly #slots: Slot[];
  readonly #now: () => number;
  readonly #opts: RpcPoolOptions;
  // one all() at a time: two callers never have requests in flight together
  #chain: Promise<unknown> = Promise.resolve();

  constructor(endpoints: readonly PoolEndpoint[], opts: RpcPoolOptions) {
    if (!endpoints.length) throw new Error('RpcPool needs at least one endpoint');
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#slots = endpoints.map(
      (e, i) => new Slot(i, endpointLabel(i, e.url), e.client, e.shared, e.chunk, new Pacer(opts.pace, this.#now, opts.sleep)),
    );
  }

  get endpoints(): ReadonlyArray<{ label: string; chunk: number; shared: boolean }> {
    return this.#slots.map((s) => ({ label: s.label, chunk: s.chunk, shared: s.shared }));
  }

  // Ingest is failing, often on a rate limit it shares with insights: slow
  // down on the endpoints it uses, leave the others alone.
  backOffShared(): void {
    for (const s of this.#slots) if (s.shared) s.pacer.backOff();
  }

  all<T>(calls: readonly Call<T>[]): Promise<PromiseSettledResult<T>[]> {
    const result = this.#chain.then(() => this.#all(calls));
    this.#chain = result.catch(() => undefined);
    return result;
  }

  async #all<T>(calls: readonly Call<T>[]): Promise<PromiseSettledResult<T>[]> {
    const out: PromiseSettledResult<T>[] = new Array(calls.length);
    // chunks are cut to the first endpoint's size; a chunk that falls through
    // to a smaller-chunk endpoint is cut again there (#send)
    const size = this.#slots[0]!.chunk;
    for (let start = 0; start < calls.length; start += size) {
      const idx = Array.from({ length: Math.min(size, calls.length - start) }, (_, k) => start + k);
      await this.#chunk(calls, idx, out);
    }
    return out;
  }

  // The next endpoint for a chunk: the first untried one that is not resting;
  // when every untried one rests, the one whose rest ends first — stalling
  // for a minute over what is usually a one-second blip costs more than one
  // early request (Radar's _order).
  #pick(tried: ReadonlySet<number>): Slot | undefined {
    const now = this.#now();
    const open = this.#slots.filter((s) => !tried.has(s.index));
    return open.find((s) => s.restUntil <= now) ?? [...open].sort((a, b) => a.restUntil - b.restUntil)[0];
  }

  async #chunk<T>(calls: readonly Call<T>[], idx: number[], out: PromiseSettledResult<T>[]): Promise<void> {
    const lastError = new Map<number, unknown>();
    const tried = new Set<number>();
    let pending = idx;
    while (pending.length) {
      const slot = this.#pick(tried);
      if (!slot) break;
      tried.add(slot.index);
      const left: number[] = [];
      for (let k = 0; k < pending.length; k += slot.chunk) {
        left.push(...(await this.#send(slot, calls, pending.slice(k, k + slot.chunk), out, lastError)));
      }
      pending = left;
    }
    for (const i of pending) out[i] = { status: 'rejected', reason: lastError.get(i) ?? new Error('no endpoint answered') };
  }

  // One request to one endpoint; returns the calls it did not answer.
  async #send<T>(
    slot: Slot, calls: readonly Call<T>[], idx: number[], out: PromiseSettledResult<T>[], lastError: Map<number, unknown>,
  ): Promise<number[]> {
    // started in one tick, so viem's batch scheduler sends them as one array
    const settled = await slot.pacer.run(() => Promise.allSettled(idx.map((i) => calls[i]!(slot.client))));
    let rateLimited = false;
    let transport = false;
    const failed: number[] = [];
    const big: number[] = [];
    settled.forEach((r, k) => {
      const i = idx[k]!;
      if (r.status === 'fulfilled') {
        out[i] = r;
        return;
      }
      lastError.set(i, r.reason);
      if (isRateLimited(r.reason)) rateLimited = true;
      else if (isTooLarge(r.reason)) {
        big.push(i);
        return;
      } else if (isTransportFailure(r.reason)) transport = true;
      failed.push(i);
    });
    this.#opts.onRequest?.(slot.index, rateLimited ? 'rate_limited' : failed.length || big.length ? 'failed' : 'ok');
    if (rateLimited) {
      slot.pacer.backOff();
      this.#rest(slot, 'rate limited');
    } else if (transport) {
      this.#rest(slot, 'failed');
    } else {
      slot.failures = 0;
      slot.restUntil = 0;
    }
    if (!big.length) return failed;
    // too large: no endpoint does better with the same batch, so halve it here
    if (big.length === 1) {
      out[big[0]!] = { status: 'rejected', reason: lastError.get(big[0]!) };
      return failed;
    }
    const half = Math.ceil(big.length / 2);
    return [
      ...failed,
      ...(await this.#send(slot, calls, big.slice(0, half), out, lastError)),
      ...(await this.#send(slot, calls, big.slice(half), out, lastError)),
    ];
  }

  #rest(slot: Slot, why: string): void {
    slot.failures++;
    const restMs = Math.min(REST_START_MS * 2 ** (slot.failures - 1), REST_MAX_MS);
    slot.restUntil = this.#now() + restMs;
    this.#opts.log?.warn({ endpoint: slot.label, why, restMs }, 'insights rpc endpoint resting');
  }
}

const sameUrl = (u: string) => u.replace(/\/+$/, '').toLowerCase();

// No transport retries and no fallback: a rate limit or a failure has to
// reach the pool (and the pacer) to move the call on and slow down.
export function createRpcPool(urls: readonly string[], ingestUrls: readonly string[], opts: RpcPoolOptions): RpcPool {
  const ingest = new Set(ingestUrls.map(sameUrl));
  return new RpcPool(
    urls.map((url) => {
      const ws = /^wss?:\/\//i.test(url);
      const transport = ws
        ? webSocket(url, { timeout: 10_000, retryCount: 0 })
        : http(url, { batch: { batchSize: CHUNK }, timeout: 10_000, retryCount: 0 });
      return { url, client: createPublicClient({ transport }), shared: ingest.has(sameUrl(url)), chunk: ws ? 1 : CHUNK };
    }),
    opts,
  );
}

async function probeChainId(url: string): Promise<number> {
  const transport = /^wss?:\/\//i.test(url)
    ? webSocket(url, { timeout: 5_000, retryCount: 0 })
    : http(url, { timeout: 5_000, retryCount: 0 });
  return createPublicClient({ transport }).getChainId();
}

// An endpoint on another chain would answer every call — with another chain's
// blocks, and wrong lanes. One that does not answer may come back; it stays
// and rests until it does.
export async function checkPoolChain(
  urls: readonly string[], chainId: number, log: Pick<Logger, 'error'>,
  probe: (url: string) => Promise<number> = probeChainId,
): Promise<string[]> {
  const kept: string[] = [];
  for (const [i, url] of urls.entries()) {
    const got = await probe(url).catch(() => null);
    if (got !== null && got !== chainId) {
      log.error({ endpoint: endpointLabel(i, url), chainId: got, expected: chainId }, 'insights rpc endpoint is on another chain — dropped');
      continue;
    }
    kept.push(url);
  }
  return kept;
}
```

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/rpcpool.test.ts`
Expected: PASS. If the "rest windows" test's helper is awkward to follow, simplify it to the same assertions (each rest length in turn, then a clear) — the behaviour, not the helper, is the requirement.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/rpcpool.ts packages/worker/test/rpcpool.test.ts
git commit -m "feat(worker): insight RPC pool — batches of 20, one request in flight, per-call fall-through

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 5: Context reads on the pool, the request metric, the wiring

**Files:**
- Modify: `packages/worker/src/txcontext.ts` (`createContextSource`, remove `createInsightsRpc` and `INSIGHTS_RPC_PACE`)
- Modify: `packages/worker/src/metrics.ts` (new counter)
- Modify: `packages/worker/src/insights.ts` (`rpcPacer` → `rpcPool`)
- Modify: `packages/worker/src/main.ts` (build the pool)
- Test: `packages/worker/test/txcontext.test.ts`, `packages/worker/test/insights.test.ts`

**Interfaces:**
- Consumes: `RpcPool`, `createRpcPool`, `checkPoolChain`, `endpointLabel`, `INSIGHTS_RPC_PACE`, `CHUNK`, `type Call` (Task 4); `WorkerConfig['insights']['rpc']` (Task 2).
- Produces:
  - `createContextSource(pool: Pick<RpcPool, 'all'>, opts?: { now?: () => number }): ContextSource`
  - `InsightsDeps.rpcPool: Pick<RpcPool, 'backOffShared'>` and `PrepareInsightsInput.rpcPool` (replace `rpcPacer`)
  - metric `metrics.insightsRpcRequests` — `arckive_insights_rpc_requests_total{endpoint, outcome}`

- [ ] **Step 1: Write the failing tests**

In `packages/worker/test/txcontext.test.ts`:

1. Replace the import of `createInsightsRpc` and `Pacer` with the pool:
```ts
import { CHUNK, RpcPool, createRpcPool, type PoolEndpoint } from '../src/rpcpool.js';
import { createContextSource, insightsRpc, isContractCode, readTokenInfo, tokenLabel } from '../src/txcontext.js';
```
2. Delete the test `'lets a rate limit through on the first answer: no retries, no fallback'` (covered by `rpcpool.test.ts`), and the now-unused `createServer`/`isRateLimited` imports if nothing else uses them.
3. In `describe('txcontext (anvil)')`, add a helper and use it wherever the tests call `createContextSource(client)`:
```ts
  const NO_PACE = { startMs: 0, minMs: 0, maxMs: 0 };
  const poolOf = (onRequest?: () => void) => createRpcPool([anvil.url], [], { pace: NO_PACE, onRequest });
```
   - `createContextSource(client)` → `createContextSource(poolOf())` (three places).
   - The test `'reads a block once for all of its transactions, through the pacer'` becomes:
```ts
  it('reads a block and its receipts in one request for all of its transactions', async () => {
    await client.request({ method: 'evm_setAutomine' as never, params: [false] as never });
    const a = artifact('Token').abi as never;
    const h1 = await wallet.writeContract({ address: token, abi: a, functionName: 'transfer', args: [WALLET2, 1n], chain: null });
    const h2 = await wallet.writeContract({ address: token, abi: a, functionName: 'transfer', args: [WALLET2, 2n], chain: null });
    await client.request({ method: 'evm_mine' as never, params: [] as never });
    await client.request({ method: 'evm_setAutomine' as never, params: [true] as never });
    const block = (await wallet.waitForTransactionReceipt({ hash: h1 })).blockNumber;
    expect((await wallet.waitForTransactionReceipt({ hash: h2 })).blockNumber).toBe(block);

    let requests = 0;
    const got = await createContextSource(poolOf(() => requests++)).contexts([
      { txHash: h1, blockNumber: block },
      { txHash: h2, blockNumber: block },
    ]);
    expect(got.get(h1)?.selector).toBe(toFunctionSelector('transfer(address,uint256)'));
    expect(got.get(h2)?.topics).toEqual([TRANSFER_TOPIC]);
    expect(requests).toBe(1); // the block and its receipts, one batch
  });
```
4. Add a fake-chain describe:
```ts
describe('txcontext on the pool (fake chain)', () => {
  const POOL = '0x' + 'cc'.repeat(20);
  const FACTORY = '0x' + 'dd'.repeat(20);
  const SENDER = '0x' + 'a1'.repeat(20);
  const txh = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

  function chain(opts: { failBlock?: bigint; failFactory?: boolean } = {}) {
    const asked = { factory: 0, code: 0 };
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber === opts.failBlock) throw new Error('block unavailable');
        return { transactions: [{ hash: txh(blockNumber), to: POOL, input: '0x12345678', from: SENDER, value: 0n }] };
      },
      getBlockReceipts: async ({ blockNumber }: { blockNumber: bigint }) => [
        { transactionHash: txh(blockNumber), logs: [{ topics: [V3_SWAP], address: POOL }] },
      ],
      call: async () => {
        asked.factory++;
        if (opts.failFactory) throw new Error('no factory()');
        return { data: `0x${'00'.repeat(12)}${FACTORY.slice(2)}` };
      },
      getCode: async () => {
        asked.code++;
        return '0x';
      },
    } as unknown as PublicClient;
    let requests = 0;
    const endpoint: PoolEndpoint = { url: 'https://fake.example', client, shared: false, chunk: CHUNK };
    const pool = new RpcPool([endpoint], { pace: { startMs: 0, minMs: 0, maxMs: 0 }, onRequest: () => requests++ });
    return { pool, asked, requests: () => requests };
  }
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ txHash: txh(BigInt(i + 1)), blockNumber: BigInt(i + 1) }));

  it('a round of 7 blocks is one request for blocks, one for factories, one for parties', async () => {
    const c = chain();
    const src = createContextSource(c.pool);
    const got = await src.contexts(refs(7));
    expect(c.requests()).toBe(2);
    expect(got.get(txh(3n))?.factories).toEqual({ [POOL]: FACTORY });
    await src.partyKinds([POOL, '0x' + 'a2'.repeat(20)]);
    expect(c.requests()).toBe(3);
  });

  it('a block that fails everywhere rejects the round', async () => {
    const c = chain({ failBlock: 4n });
    await expect(createContextSource(c.pool).contexts(refs(7))).rejects.toThrow(/block unavailable/);
  });

  it('a pool whose factory() fails is not asked again for ten minutes', async () => {
    const c = chain({ failFactory: true });
    const clock = { t: 0 };
    const src = createContextSource(c.pool, { now: () => clock.t });
    expect((await src.contexts(refs(1))).get(txh(1n))?.factories).toEqual({});
    await src.contexts(refs(1));
    expect(c.asked.factory).toBe(1);
    clock.t += 600_001;
    await src.contexts(refs(1));
    expect(c.asked.factory).toBe(2);
  });
});
```

In `packages/worker/test/insights.test.ts`, rename the fake and the field:

```ts
function fakePool() {
  return { backOffs: 0, backOffShared() { this.backOffs++; } };
}
```
and every `rpcPacer: fakePacer()` → `rpcPool: fakePool()`; in `'slows its RPC pace while ingest is Degraded'`: `const pacer = fakePool(); deps.rpcPool = pacer;` (keep the assertion on `pacer.backOffs`).

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/txcontext.test.ts test/insights.test.ts`
Expected: FAIL — type/runtime errors: `createContextSource` expects a client, `rpcPool` unknown.

- [ ] **Step 3: Implement `txcontext.ts`**

1. Imports: drop `http`, `webSocket` and the pacer import; add the pool:
```ts
import {
  AbiDecodingZeroDataError, BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError,
  erc20Abi, type PublicClient,
} from 'viem';
import { FACTORY_CALL, POOL_TOPICS, ZERO_ADDRESS, type TokenInfo, type TxContext } from '@arckive/core';
import type { RpcPool } from './rpcpool.js';
```
2. Delete `INSIGHTS_RPC_PACE`, its comment block ("Every RPC call made for insights goes through one pacer…"), and `createInsightsRpc` with its comment. Keep `insightsRpc` and its comment, and extend that comment's last sentence: "…than the one ingest depends on. `spec.insights.rpc` replaces this choice with a list of its own."
3. Update the file header comment's last sentence to: "…so per block is a third of the calls; the pool (rpcpool.ts) sends a round's blocks ten to a request."
4. Replace `ContextSourceOptions` and `createContextSource` up to `async contexts(txs) {` and the reading of blocks, factories and codes:

```ts
export interface ContextSourceOptions {
  now?: () => number;
}

const fullBlock = (c: PublicClient, blockNumber: bigint) => c.getBlock({ blockNumber, includeTransactions: true });
const blockReceipts = (c: PublicClient, blockNumber: bigint) => c.getBlockReceipts({ blockNumber });
type FullBlock = Awaited<ReturnType<typeof fullBlock>>;
type Receipts = Awaited<ReturnType<typeof blockReceipts>>;

// One round's reads go through the pool in three batches at most: every
// block with its receipts, then the new pools' factory(), then the new
// parties' code.
export function createContextSource(pool: Pick<RpcPool, 'all'>, opts: ContextSourceOptions = {}): ContextSource {
  const now = opts.now ?? Date.now;
  const codes = new Lru<boolean>(CACHE_MAX);
  const factories = new Lru<string>(CACHE_MAX);
  const unreadable = new Map<string, number>(); // pool -> when factory() may be asked again

  // The wanted transactions of one block, from the block and its receipts.
  function collect(block: FullBlock, receipts: Receipts, wanted: ReadonlySet<string>, out: Map<string, TxContext>): void {
    const byHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));
    for (const tx of block.transactions) {
      const hash = tx.hash.toLowerCase();
      const receipt = byHash.get(hash);
      if (!wanted.has(hash) || !receipt) continue;
      const logs = receipt.logs.filter((l) => l.topics.length > 0);
      const input = tx.input ?? '0x';
      out.set(hash, {
        to: tx.to ? tx.to.toLowerCase() : null,
        selector: input.length >= 10 ? input.slice(0, 10).toLowerCase() : '0x',
        topics: logs.map((l) => l.topics[0]!.toLowerCase()),
        sender: tx.from.toLowerCase(),
        emitters: logs.map((l) => l.address.toLowerCase()),
        factories: {},
        valueSent: tx.value > 0n,
      });
    }
  }

  return {
    async contexts(txs) {
      const byBlock = new Map<bigint, Set<string>>();
      for (const t of txs) {
        const set = byBlock.get(t.blockNumber) ?? new Set<string>();
        set.add(t.txHash.toLowerCase());
        byBlock.set(t.blockNumber, set);
      }
      const blocks = [...byBlock.keys()];
      const reads = await pool.all<FullBlock | Receipts>(
        blocks.flatMap((b) => [(c: PublicClient) => fullBlock(c, b), (c: PublicClient) => blockReceipts(c, b)]),
      );
      const read = new Map<string, TxContext>();
      blocks.forEach((b, k) => {
        const block = reads[2 * k]!;
        const receipts = reads[2 * k + 1]!;
        // every endpoint failed this block: the round fails and is retried
        if (block.status === 'rejected') throw block.reason;
        if (receipts.status === 'rejected') throw receipts.reason;
        collect(block.value as FullBlock, receipts.value as Receipts, byBlock.get(b)!, read);
      });

      const poolsOf = new Map<string, string[]>();
      for (const [hash, c] of read) {
        poolsOf.set(hash, [...new Set(c.emitters.filter((e, i) => e && POOL_TOPICS.has(c.topics[i]!)))]);
      }
      const clock = now();
      const ask = [...new Set([...poolsOf.values()].flat())].filter(
        (p) => factories.get(p) === undefined && (unreadable.get(p) ?? 0) <= clock,
      );
      // Which exchange a swap happened on is a fact about the pool, not about
      // the event it logs: Uniswap v3's Swap is logged, byte for byte, by every fork.
      const answers = await pool.all(ask.map((p) => (c: PublicClient) => c.call({ to: p as `0x${string}`, data: FACTORY_CALL })));
      ask.forEach((p, k) => {
        const a = answers[k]!;
        const data = a.status === 'fulfilled' ? a.value.data : undefined;
        if (data && data.length >= 42) {
          factories.set(p, `0x${data.slice(-40).toLowerCase()}`);
          unreadable.delete(p);
        } else {
          // a contract that logs a pool event but has no factory() — retried later
          unreadable.set(p, clock + FACTORY_RETRY_MS);
        }
      });
      if (unreadable.size > 10_000) {
        for (const [p, until] of unreadable) if (until <= clock) unreadable.delete(p);
      }
      const out = new Map<string, TxContext | null>();
      for (const t of txs) {
        const c = read.get(t.txHash.toLowerCase()) ?? null;
        if (c) {
          for (const p of poolsOf.get(t.txHash.toLowerCase()) ?? []) {
            const f = factories.get(p);
            if (f) c.factories[p] = f;
          }
        }
        out.set(t.txHash, c);
      }
      return out;
    },

    async partyKinds(addresses) {
      const wanted = [...new Set(addresses)].filter((a) => a !== ZERO_ADDRESS);
      const unknown = wanted.filter((x) => codes.get(x) === undefined);
      const got = await pool.all(unknown.map((a) => (c: PublicClient) => c.getCode({ address: a as `0x${string}` })));
      unknown.forEach((a, k) => {
        const r = got[k]!;
        if (r.status === 'rejected') throw r.reason;
        codes.set(a, isContractCode(r.value));
      });
      const out: Record<string, boolean> = {};
      for (const a of wanted) {
        const v = codes.get(a);
        if (v !== undefined) out[a] = v;
      }
      return out;
    },
  };
}
```

(`RpcPool.all([])` returns `[]` without a request, so a round with nothing to ask sends nothing.)

- [ ] **Step 4: Implement the metric**

In `packages/worker/src/metrics.ts`, after `insightsErrors`:

```ts
    insightsRpcRequests: new Counter({
      name: 'arckive_insights_rpc_requests_total',
      help: 'requests the insight RPC pool sent, by endpoint index and outcome (ok, rate_limited, failed)',
      labelNames: ['endpoint', 'outcome'] as const,
      registers: [registry],
    }),
```

- [ ] **Step 5: Implement in `insights.ts`**

- Replace `import type { Pacer } from './pacer.js';` with `import type { RpcPool } from './rpcpool.js';`.
- In `InsightsDeps`, replace the `rpcPacer` field and its comment with:
```ts
  // the pool every insight RPC call goes through (rpcpool.ts)
  rpcPool: Pick<RpcPool, 'backOffShared'>;
```
- In `runInsightsLoop`: `if (phase === 'Degraded') deps.rpcPool.backOffShared();`
- In `PrepareInsightsInput`: `rpcPool: Pick<RpcPool, 'backOffShared'>;` (replaces `rpcPacer`), and in the returned deps `rpcPool: input.rpcPool,`.

- [ ] **Step 6: Wire it in `main.ts`**

Replace the imports
```ts
import { Pacer } from './pacer.js';
import { INSIGHTS_RPC_PACE, createContextSource, createInsightsRpc, readTokenInfo } from './txcontext.js';
```
with
```ts
import { INSIGHTS_RPC_PACE, checkPoolChain, createRpcPool } from './rpcpool.js';
import { createContextSource, insightsRpc, readTokenInfo } from './txcontext.js';
```
and replace the block from `// Insights (optional) run beside ingest…` to `if (insights) deps.onCommitted = …` with:

```ts
  // Insights (optional) run beside ingest, woken by each committed range.
  // Their reads use insights.rpc, or else the last http endpoint of
  // network.rpc (insightsRpc), never ingest's whole list.
  const insightsWake = new HeadSignal();
  const insightUrls = cfg.insights
    ? await checkPoolChain(cfg.insights.rpc ?? [insightsRpc(rpcs)], cfg.network.chainId, log)
    : [];
  const insightsPool = insightUrls.length
    ? createRpcPool(insightUrls, rpcs, {
        pace: INSIGHTS_RPC_PACE,
        log,
        onRequest: (endpoint, outcome) => metrics.insightsRpcRequests.inc({ endpoint: String(endpoint), outcome }),
      })
    : null;
  if (cfg.insights && !insightsPool) log.error('insights: every insight endpoint is on another chain — insights stay off');
  if (insightsPool) log.info({ endpoints: insightsPool.endpoints }, 'insights rpc pool');
  const insights = cfg.insights && insightsPool
    ? await prepareInsights({
        cfg, pool, schema: deps.schema, defs, abis, metrics, log, wake: insightsWake,
        context: createContextSource(insightsPool),
        // native USDC has no symbol()/decimals() to read (core insights/tokens.ts)
        readToken: async (address, fallback) =>
          knownToken(cfg.network.chainId, address) ?? readTokenInfo(client, address, fallback),
        headerLine: process.env['INSIGHTS_HEADER'],
        ingestPhase: () => phase.phase,
        rpcPool: insightsPool,
        compactor,
      })
    : null;
  if (insights) deps.onCommitted = () => insightsWake.notify();
```

- [ ] **Step 7: Run the worker suite**

Run: `corepack pnpm --filter @arckive/worker exec tsc --noEmit -p tsconfig.json && corepack pnpm --filter @arckive/worker exec vitest run`
Expected: typecheck clean; all worker tests PASS (anvil tests included). Also `grep -rn "createInsightsRpc\|rpcPacer" packages/` returns nothing.

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/txcontext.ts packages/worker/src/metrics.ts packages/worker/src/insights.ts \
  packages/worker/src/main.ts packages/worker/test/txcontext.test.ts packages/worker/test/insights.test.ts
git commit -m "feat(worker): insight reads go through the batched pool; insights.rpc endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 6: `insights.startBlock`

**Files:**
- Modify: `packages/worker/src/insightsdb.ts` (`bootstrapInsights`, new `initInsightsCursor`)
- Modify: `packages/worker/src/insights.ts` (`insightsStart`, `InsightsDeps.start`, `prepareRound`, `prepareInsights`)
- Test: `packages/worker/test/insights.test.ts`

**Interfaces:**
- Consumes: `WorkerConfig['insights']['startBlock']` (Task 2), `initialCursor(cfg)` from `pipeline.js`.
- Produces:
  - `type InsightsStart = { cursor: bigint } | { behindHead: bigint; floor: bigint }`
  - `insightsStart(cfg: WorkerConfig): InsightsStart`
  - `InsightsDeps.start: InsightsStart`
  - `bootstrapInsights(pool, schema, start: bigint | null): Promise<void>` — `null` creates tables only
  - `initInsightsCursor(pool, schema, lastBlock: bigint): Promise<void>` — insert if absent

- [ ] **Step 1: Write the failing tests**

In `packages/worker/test/insights.test.ts`: add `start: { cursor: 99n },` to the `deps` object in `beforeEach`; import `insightsStart` from `../src/insights.js` and `initInsightsCursor` from `../src/insightsdb.js`. Then add:

```ts
  describe('insights.startBlock', () => {
    const cfgWith = (startBlock?: number) => parseWorkerConfig({
      indexerName: 'ins',
      network: { chainId: 31337, rpc: ['http://127.0.0.1:1'] },
      contracts: [
        { name: 'tok', address: TOKEN, abiInline: [], startBlock: 50 },
        { name: 'vault', address: VAULT, abiInline: [], startBlock: 70 },
      ],
      insights: { laya: { url: 'https://gate.example' }, ...(startBlock === undefined ? {} : { startBlock }) },
    });

    it('resolves to a cursor, clamped to the ingest start, or to "this far behind the head"', () => {
      expect(insightsStart(cfgWith())).toEqual({ cursor: 49n });
      expect(insightsStart(cfgWith(100))).toEqual({ cursor: 99n });
      expect(insightsStart(cfgWith(10))).toEqual({ cursor: 49n });
      expect(insightsStart(cfgWith(-5))).toEqual({ behindHead: 5n, floor: 49n });
    });

    it('relative: the first round writes the cursor that far behind the ingest cursor', async () => {
      await pool.query(`DELETE FROM ${SCHEMA}._insights_cursor`);
      deps.start = { behindHead: 5n, floor: 99n };
      await commitBatch(pool, store, [transferRow(110, 1, 5_000_000n), transferRow(118, 2, 1n)], [], 120n);
      while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
      expect((await insights()).map((r) => r.block_number)).toEqual(['118']); // 115 < 118, 110 skipped
      expect(await getInsightsCursor(pool, SCHEMA)).toBe(120n);
    });

    it('relative: a young indexer clamps to the ingest start', async () => {
      await pool.query(`DELETE FROM ${SCHEMA}._insights_cursor`);
      deps.start = { behindHead: 1_000n, floor: 99n };
      await commitBatch(pool, store, [transferRow(110, 1, 5_000_000n), transferRow(118, 2, 1n)], [], 120n);
      while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
      expect((await insights()).map((r) => r.block_number)).toEqual(['110', '118']);
    });

    it('an existing cursor is never moved by the start setting', async () => {
      deps.start = { behindHead: 5n, floor: 99n }; // beforeEach already wrote cursor 99
      await commitBatch(pool, store, [transferRow(110, 1, 5_000_000n)], [], 120n);
      while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
      expect((await insights()).map((r) => r.block_number)).toEqual(['110']);
      await initInsightsCursor(pool, SCHEMA, 7n);
      expect(await getInsightsCursor(pool, SCHEMA)).toBe(120n);
    });

    it('prepareInsights writes an absolute start at once and a relative one not yet', async () => {
      const base = {
        pool, schema: SCHEMA, defs, abis: [[], []],
        metrics: createMetrics('start'), log: pino({ level: 'silent' }), wake: new HeadSignal(),
        context: fakeContext({}), readToken: async () => ({ label: 'TKN', decimals: 6 }),
        ingestPhase: () => 'Live' as const, rpcPool: fakePool(), headerLine: undefined,
      };
      await pool.query(`DELETE FROM ${SCHEMA}._insights_cursor`);
      await prepareInsights({ ...base, cfg: cfgWith(-5) });
      expect(await getInsightsCursor(pool, SCHEMA)).toBeNull();
      await prepareInsights({ ...base, cfg: cfgWith(60) });
      expect(await getInsightsCursor(pool, SCHEMA)).toBe(59n);
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/insights.test.ts -t "startBlock"`
Expected: FAIL — `insightsStart` is not exported; `deps.start` unknown.

- [ ] **Step 3: Implement `insightsdb.ts`**

```ts
// start: the initial insights cursor, or null to create the tables only —
// a start relative to the head is written by the loop's first round
// (insights.ts prepareRound), when the head is known.
export async function bootstrapInsights(pool: pg.Pool, schema: string, start: bigint | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of buildInsightsTables(schema)) await client.query(s);
    if (start !== null) {
      await client.query(
        `INSERT INTO ${q(schema)}._insights_cursor (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
        [start.toString()],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Written once: an existing cursor is the loop's progress and is never moved.
export async function initInsightsCursor(pool: pg.Pool, schema: string, lastBlock: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO ${q(schema)}._insights_cursor (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [lastBlock.toString()],
  );
}
```

- [ ] **Step 4: Implement `insights.ts`**

Add to the imports from `./insightsdb.js`: `initInsightsCursor`. Add after `insightTargets`:

```ts
// Where lanes begin (spec.insights.startBlock). Omitted: the indexer's own
// start. Absolute: that block, never before the indexer's start. Negative:
// that many blocks before the head when the loop first runs — a
// full-history indexer backfills for hours before insights run (they wait
// for Live), and a head read at pod start would by then be hours old, older
// than some providers serve without a token.
export type InsightsStart = { cursor: bigint } | { behindHead: bigint; floor: bigint };

export function insightsStart(cfg: WorkerConfig): InsightsStart {
  const floor = initialCursor(cfg);
  const at = cfg.insights?.startBlock;
  if (at === undefined) return { cursor: floor };
  if (at < 0) return { behindHead: BigInt(-at), floor };
  const cursor = BigInt(at) - 1n;
  return { cursor: cursor > floor ? cursor : floor };
}
```

In `InsightsDeps`, add:
```ts
  start: InsightsStart; // used once, if the schema has no insights cursor yet
```

In `prepareRound`, replace the first lines up to `metrics.insightsBlocksBehind.set(…)` with:

```ts
  const { pool, schema, metrics } = deps;
  const [stored, ingested] = await at('db', Promise.all([getInsightsCursor(pool, schema), getCursor(pool, schema)]));
  if (ingested === null) throw new Error('no ingest cursor — call bootstrapIndexer first');
  let done = stored;
  if (done === null) {
    if (!('behindHead' in deps.start)) throw new Error('no insights cursor — call bootstrapInsights first');
    // Rounds run only while ingest is Live, so its cursor is the head.
    const from = ingested - deps.start.behindHead;
    await at('db', initInsightsCursor(pool, schema, from > deps.start.floor ? from : deps.start.floor));
    done = await at('db', getInsightsCursor(pool, schema));
    deps.log.info({ cursor: String(done) }, 'insights start resolved against the head');
    if (done === null) throw new Error('insights cursor missing after initInsightsCursor');
  }
  metrics.insightsBlocksBehind.set(Number(ingested > done ? ingested - done : 0n));
```

In `prepareInsights`, replace `await bootstrapInsights(input.pool, input.schema, initialCursor(cfg));` with:

```ts
  const start = insightsStart(cfg);
  await bootstrapInsights(input.pool, input.schema, 'cursor' in start ? start.cursor : null);
```

and add `start,` to the returned deps object. (`initialCursor` stays imported: `insightsStart` uses it.)

- [ ] **Step 5: Run the insights tests**

Run: `corepack pnpm --filter @arckive/worker exec vitest run test/insights.test.ts test/insightsdb.test.ts`
Expected: PASS. If `insightsdb.test.ts` calls `bootstrapInsights(pool, schema, n)` with a bigint, it is unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/insights.ts packages/worker/src/insightsdb.ts packages/worker/test/insights.test.ts
git commit -m "feat(worker): insights.startBlock — lanes from a block, or from N behind the head when insights first run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 7: Operator reconciles on change, one at a time

**Files:**
- Create: `packages/operator/src/gate.ts`
- Modify: `packages/operator/src/main.ts`
- Test: `packages/operator/test/gate.test.ts`

**Interfaces:**
- Consumes: `Indexer` from `./kinds.js`.
- Produces: `type ReconcileFn = (cr: Indexer) => Promise<boolean>`; `class ReconcileGate { constructor(reconcile: ReconcileFn); watch(cr: Indexer, phase: string): Promise<void>; resync(cr: Indexer): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/operator/test/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Indexer } from '../src/kinds.js';
import { ReconcileGate } from '../src/gate.js';

const cr = (generation: number, uid = 'u1', name = 'demo'): Indexer =>
  ({ metadata: { name, namespace: 'default', uid, generation } }) as Indexer;

function recorder(result = true) {
  const seen: Array<number | undefined> = [];
  const gate = new ReconcileGate(async (c) => {
    seen.push(c.metadata?.generation);
    return result;
  });
  return { gate, seen };
}

describe('ReconcileGate', () => {
  it('reconciles ADDED, then skips MODIFIED events that keep the generation (status writes)', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(1), 'MODIFIED');
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1]);
  });

  it('reconciles a MODIFIED event with a new generation (a spec change)', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(2), 'MODIFIED');
    expect(seen).toEqual([1, 2]);
  });

  it('a resync reconciles whatever the generation', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.resync(cr(1));
    expect(seen).toEqual([1, 1]);
  });

  it('DELETED forgets the Indexer; BOOKMARK and ERROR do nothing', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(1), 'DELETED');
    await gate.watch(cr(1), 'BOOKMARK');
    await gate.watch(cr(1), 'ERROR');
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1, 1]);
  });

  it('a failed reconcile is retried on the next event, not at the next resync', async () => {
    const { gate, seen } = recorder(false);
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1, 1]);
  });

  it('runs one reconcile per Indexer at a time and one rerun with the latest object', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const seen: number[] = [];
    let running = 0;
    let most = 0;
    const gate = new ReconcileGate(async (c) => {
      running++;
      most = Math.max(most, running);
      seen.push(c.metadata!.generation!);
      if (seen.length === 1) await blocked;
      running--;
      return true;
    });
    const first = gate.watch(cr(1), 'ADDED');
    const queued = [gate.watch(cr(2), 'MODIFIED'), gate.watch(cr(3), 'MODIFIED'), gate.watch(cr(4), 'MODIFIED')];
    release();
    await Promise.all([first, ...queued]);
    expect(seen).toEqual([1, 4]);
    expect(most).toBe(1);
  });

  it('Indexers do not wait for each other', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const gate = new ReconcileGate(async (c) => {
      seen.push(c.metadata!.uid!);
      if (c.metadata!.uid === 'a') await blocked;
      return true;
    });
    const a = gate.watch(cr(1, 'a', 'a'), 'ADDED');
    await gate.watch(cr(1, 'b', 'b'), 'ADDED');
    expect(seen).toEqual(['a', 'b']);
    release();
    await a;
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `corepack pnpm --filter @arckive/operator exec vitest run test/gate.test.ts`
Expected: FAIL — `Cannot find module '../src/gate.js'`.

- [ ] **Step 3: Implement `packages/operator/src/gate.ts`**

```ts
import type { Indexer } from './kinds.js';

// Decides which watch events cost a reconcile, and runs at most one reconcile
// per Indexer at a time.
//
// Every worker patches its Indexer's .status every 10 s, and each patch is a
// watch event. Reconciling them all cost ~8 API requests per Indexer every
// 10 s for nothing — status never changes what the operator renders — and
// was one reconcile every 3.3 s with three Indexers when the operator was
// OOMKilled. Status writes do not bump metadata.generation on a CRD with the
// status subresource; spec changes do.
export type ReconcileFn = (cr: Indexer) => Promise<boolean>; // false: it failed

export class ReconcileGate {
  // key -> generation last reconciled, or queued to be
  readonly #generation = new Map<string, number | undefined>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, Indexer>();

  constructor(private readonly reconcile: ReconcileFn) {}

  watch(cr: Indexer, phase: string): Promise<void> {
    const key = keyOf(cr);
    if (!key) return Promise.resolve();
    if (phase === 'DELETED') {
      this.#generation.delete(key);
      return Promise.resolve();
    }
    if (phase === 'MODIFIED' && this.#generation.has(key) && this.#generation.get(key) === cr.metadata?.generation) {
      return Promise.resolve();
    }
    if (phase !== 'ADDED' && phase !== 'MODIFIED') return Promise.resolve(); // BOOKMARK, ERROR
    return this.#schedule(key, cr);
  }

  // The periodic resync reconciles whatever the generation: it is how a
  // Secret or ConfigMap created after its Indexer is noticed.
  resync(cr: Indexer): Promise<void> {
    const key = keyOf(cr);
    return key ? this.#schedule(key, cr) : Promise.resolve();
  }

  #schedule(key: string, cr: Indexer): Promise<void> {
    this.#generation.set(key, cr.metadata?.generation);
    const running = this.#running.get(key);
    if (running) {
      // one rerun after the current reconcile, with the latest object
      this.#pending.set(key, cr);
      return running;
    }
    const run = (async () => {
      let next: Indexer | undefined = cr;
      while (next) {
        const generation = next.metadata?.generation;
        const ok = await this.reconcile(next);
        // A failed reconcile forgets its generation, so the next event for
        // this Indexer tries again instead of waiting for the resync.
        if (!ok && this.#generation.get(key) === generation) this.#generation.delete(key);
        next = this.#pending.get(key);
        this.#pending.delete(key);
      }
      this.#running.delete(key);
    })();
    this.#running.set(key, run);
    return run;
  }
}

function keyOf(cr: Indexer): string | undefined {
  const m = cr.metadata;
  return m?.uid ?? (m?.name ? `${m.namespace ?? ''}/${m.name}` : undefined);
}
```

- [ ] **Step 4: Wire it in `main.ts`**

Add `import { ReconcileGate } from './gate.js';`. Replace `safeReconcile`, the watch and the resync loop:

```ts
  const safeReconcile = async (cr: Indexer): Promise<boolean> => {
    try {
      await reconcile(deps, cr);
      return true;
    } catch (err) {
      log.error({ err, indexer: cr.metadata?.name }, 'reconcile error');
      return false;
    }
  };
  const gate = new ReconcileGate(safeReconcile);
```

```ts
  // Status-only events are dropped by the gate (gate.ts); cleanup of deleted
  // CRs is handled by ownerReferences + GC.
  const watcher = K8s(Indexer).Watch((cr, phase) => {
    void gate.watch(cr, phase);
  });
```

```ts
      .then(async (crs) => {
        for (const cr of crs) await gate.resync(cr);
      })
```

- [ ] **Step 5: Run the operator suite**

Run: `corepack pnpm --filter @arckive/operator exec tsc --noEmit -p tsconfig.json && corepack pnpm --filter @arckive/operator exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/operator/src/gate.ts packages/operator/src/main.ts packages/operator/test/gate.test.ts
git commit -m "fix(operator): reconcile on spec changes and resync only, one at a time per Indexer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 8: Operator's own Kubernetes client (the leak)

**Files:**
- Create: `packages/operator/src/kubehttp.ts`
- Modify: `packages/operator/src/kube.ts` (rewrite `createKubeApi` on `KubeHttp`)
- Modify: `packages/operator/src/main.ts`
- Modify: `packages/operator/package.json` (add `"@kubernetes/client-node": "1.4.0"`), `pnpm-lock.yaml`
- Test: `packages/operator/test/kube.test.ts`
- Scratch (not committed): `<scratchpad>/kfc-leak/repro.mjs`

**Interfaces:**
- Consumes: `KubeApi` interface (unchanged), `Indexer`.
- Produces:
  - `class KubeHttpError extends Error { readonly status: number }`
  - `interface KubeConnection { server: string; tls: Pick<https.RequestOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized' | 'servername'>; headers: () => Promise<Record<string, string>> }`
  - `interface KubeHttp { get(path: string): Promise<unknown>; patch(path: string, contentType: string, body: unknown): Promise<unknown>; close(): void }` — `get` returns `null` on 404
  - `createKubeHttp(conn: KubeConnection): KubeHttp`
  - `connectionFromKubeConfig(kc?: KubeConfig): Promise<KubeConnection>`
  - `createKubeApi(http: KubeHttp): KubeApi`; `objectPath(apiVersion, kind, namespace, name?): string`

- [ ] **Step 1: Reproduce the leak before fixing it**

The scratchpad is the session's scratchpad directory. Write `<scratchpad>/kfc-leak/repro.mjs`:

```js
// N fluent-client GETs against a local HTTPS server: how many connections?
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kfc-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`, { stdio: 'ignore' });
let connections = 0;
const server = createServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (req, res) => {
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"kind":"Status","code":404}');
});
server.on('secureConnection', () => connections++);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
writeFileSync(`${dir}/kubeconfig`, `apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://127.0.0.1:${port}", insecure-skip-tls-verify: true } }]
users: [{ name: u, user: { token: t } }]
contexts: [{ name: x, context: { cluster: c, user: u } }]
current-context: x
`);
process.env.KUBECONFIG = `${dir}/kubeconfig`;
const { K8s, kind } = await import('kubernetes-fluent-client');
const N = 30;
for (let i = 0; i < N; i++) await K8s(kind.ConfigMap).InNamespace('x').Get('y').catch(() => {});
console.log(JSON.stringify({ requests: N, connections }));
server.closeAllConnections();
server.close();
```

Run from the operator package so the library resolves:
`cd packages/operator && node <scratchpad>/kfc-leak/repro.mjs`
Expected: `{"requests":30,"connections":30}` — one new TLS connection per request, which confirms the hypothesis in spec §6. Record the output in the ledger. If it prints fewer connections than requests, stop and re-open the investigation (systematic-debugging Phase 1): the fix below assumes this evidence.

- [ ] **Step 2: Add the dependency**

Run: `corepack pnpm --filter @arckive/operator add @kubernetes/client-node@1.4.0`
Expected: `package.json` lists it; the lockfile dedupes with fluent-client's copy.

- [ ] **Step 3: Write the failing tests**

Create `packages/operator/test/kube.test.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it } from 'vitest';
import { createKubeApi } from '../src/kube.js';
import { KubeHttpError, connectionFromKubeConfig, createKubeHttp } from '../src/kubehttp.js';

interface Seen { method: string; url: string; type?: string; auth?: string; body: string }

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); } });

async function apiServer(reply: (req: IncomingMessage) => { status: number; json?: unknown }) {
  const seen: Seen[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, type: req.headers['content-type'], auth: req.headers['authorization'], body });
      const { status, json } = reply(req);
      res.writeHead(status, { 'content-type': 'application/json' }).end(json === undefined ? '' : JSON.stringify(json));
    });
  });
  server.on('connection', () => connections++);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let n = 0;
  const http = createKubeHttp({
    server: `http://127.0.0.1:${port}`, tls: {},
    headers: async () => ({ authorization: `Bearer t${n++}` }),
  });
  return { http, seen, connections: () => connections };
}

describe('createKubeApi over KubeHttp', () => {
  it('gets a ConfigMap and a Secret; a 404 is null', async () => {
    const s = await apiServer((req) => (req.url!.endsWith('/missing') ? { status: 404 } : { status: 200, json: { data: { k: 'v' } } }));
    const api = createKubeApi(s.http);
    expect(await api.getConfigMap('ns', 'abi')).toEqual({ data: { k: 'v' } });
    expect(await api.getSecret('ns', 'missing')).toBeNull();
    expect(s.seen.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/namespaces/ns/configmaps/abi',
      'GET /api/v1/namespaces/ns/secrets/missing',
    ]);
  });

  it('applies server-side, forced, as arckive-operator', async () => {
    const s = await apiServer(() => ({ status: 200, json: {} }));
    const api = createKubeApi(s.http);
    const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'w', namespace: 'ns' }, spec: { replicas: 1 } };
    await api.applyDeployment(deployment as never);
    await api.applyRole({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'r', namespace: 'ns' } } as never);
    await api.applyConfigMap({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', namespace: 'ns' } } as never);
    expect(s.seen.map((x) => `${x.method} ${x.url} ${x.type}`)).toEqual([
      'PATCH /apis/apps/v1/namespaces/ns/deployments/w?fieldManager=arckive-operator&force=true application/apply-patch+yaml',
      'PATCH /apis/rbac.authorization.k8s.io/v1/namespaces/ns/roles/r?fieldManager=arckive-operator&force=true application/apply-patch+yaml',
      'PATCH /api/v1/namespaces/ns/configmaps/c?fieldManager=arckive-operator&force=true application/apply-patch+yaml',
    ]);
    expect(JSON.parse(s.seen[0]!.body)).toEqual(deployment);
  });

  it('merge-patches the Indexer status and lists Indexers', async () => {
    const s = await apiServer((req) => (req.method === 'GET' ? { status: 200, json: { items: [{ metadata: { name: 'a' } }] } } : { status: 200, json: {} }));
    const api = createKubeApi(s.http);
    await api.patchIndexerStatus('ns', 'demo', { observedGeneration: 3 });
    expect(await api.listIndexers()).toEqual([{ metadata: { name: 'a' } }]);
    expect(s.seen[0]).toMatchObject({
      method: 'PATCH', url: '/apis/arckive.org/v1alpha1/namespaces/ns/indexers/demo/status', type: 'application/merge-patch+json',
    });
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ status: { observedGeneration: 3 } });
    expect(s.seen[1]).toMatchObject({ method: 'GET', url: '/apis/arckive.org/v1alpha1/indexers' });
  });

  it('throws KubeHttpError with the status for anything but 2xx (and 404 on a get)', async () => {
    const s = await apiServer((req) => (req.method === 'GET' ? { status: 403, json: { message: 'forbidden' } } : { status: 500 }));
    const api = createKubeApi(s.http);
    await expect(api.getSecret('ns', 'x')).rejects.toMatchObject({ name: 'KubeHttpError', status: 403 });
    await expect(api.patchIndexerStatus('ns', 'x', {})).rejects.toBeInstanceOf(KubeHttpError);
  });

  it('asks for the auth header on every request, so a rotated token is used', async () => {
    const s = await apiServer(() => ({ status: 200, json: {} }));
    const api = createKubeApi(s.http);
    await api.getConfigMap('ns', 'a');
    await api.getConfigMap('ns', 'b');
    expect(s.seen.map((x) => x.auth)).toEqual(['Bearer t0', 'Bearer t1']);
  });

  it('50 requests share one connection', async () => {
    const s = await apiServer(() => ({ status: 200, json: {} }));
    const api = createKubeApi(s.http);
    for (let i = 0; i < 50; i++) await api.getConfigMap('ns', `c${i}`);
    expect(s.connections()).toBe(1);
    s.http.close();
  });
});

describe('connectionFromKubeConfig', () => {
  it('takes the server, TLS settings and a bearer token from a kubeconfig', async () => {
    const kc = new KubeConfig();
    kc.loadFromString(`apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://127.0.0.1:6443", insecure-skip-tls-verify: true } }]
users: [{ name: u, user: { token: tok } }]
contexts: [{ name: x, context: { cluster: c, user: u } }]
current-context: x
`);
    const conn = await connectionFromKubeConfig(kc);
    expect(conn.server).toBe('https://127.0.0.1:6443');
    expect(conn.tls.rejectUnauthorized).toBe(false);
    expect(await conn.headers()).toMatchObject({ Authorization: 'Bearer tok' });
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `corepack pnpm --filter @arckive/operator exec vitest run test/kube.test.ts`
Expected: FAIL — `Cannot find module '../src/kubehttp.js'`.

- [ ] **Step 5: Implement `packages/operator/src/kubehttp.ts`**

```ts
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from 'node:https';
import { KubeConfig } from '@kubernetes/client-node';

// The operator's Kubernetes API client for gets, applies and status patches.
//
// kubernetes-fluent-client (3.11.7, and 3.12.4 still) builds a new undici
// Agent with a 10-minute keep-alive for every request and never closes it,
// so each request left a TLS connection open for ten minutes: ~145 requests
// a minute at one reconcile per 3.3 s held ~1,450 connections and filled the
// operator's 256 Mi. This client keeps one agent for the process. The
// library is still used for the watch — one long-lived connection.

export class KubeHttpError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path}: HTTP ${status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    this.name = 'KubeHttpError';
    this.status = status;
  }
}

export interface KubeConnection {
  server: string; // https://host:port (http:// in tests)
  tls: Pick<RequestOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized' | 'servername'>;
  // asked per request: a projected service-account token rotates
  headers: () => Promise<Record<string, string>>;
}

export interface KubeHttp {
  get(path: string): Promise<unknown>; // null on 404
  patch(path: string, contentType: string, body: unknown): Promise<unknown>;
  close(): void;
}

export function createKubeHttp(conn: KubeConnection): KubeHttp {
  const secure = conn.server.startsWith('https:');
  const agent = secure
    ? new HttpsAgent({ keepAlive: true, maxSockets: 4, ...conn.tls })
    : new HttpAgent({ keepAlive: true, maxSockets: 4 });

  async function send(method: 'GET' | 'PATCH', path: string, body?: { type: string; json: unknown }) {
    const url = new URL(path, conn.server);
    const data = body ? JSON.stringify(body.json) : undefined;
    const headers: Record<string, string | number> = { accept: 'application/json', ...(await conn.headers()) };
    if (body) {
      headers['content-type'] = body.type;
      headers['content-length'] = Buffer.byteLength(data!);
    }
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = (secure ? httpsRequest : httpRequest)(url, { method, agent, headers, timeout: 30_000 }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timed out`)));
      req.on('error', reject);
      req.end(data);
    });
  }

  function parse(method: string, path: string, r: { status: number; text: string }): unknown {
    if (r.status < 200 || r.status >= 300) throw new KubeHttpError(method, path, r.status, r.text);
    return r.text ? JSON.parse(r.text) : null;
  }

  return {
    async get(path) {
      const r = await send('GET', path);
      return r.status === 404 ? null : parse('GET', path, r);
    },
    async patch(path, contentType, json) {
      return parse('PATCH', path, await send('PATCH', path, { type: contentType, json }));
    },
    close() {
      agent.destroy();
    },
  };
}

function loadDefault(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault(); // KUBECONFIG / ~/.kube/config, else the in-cluster service account
  return kc;
}

export async function connectionFromKubeConfig(kc: KubeConfig = loadDefault()): Promise<KubeConnection> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('no current Kubernetes cluster in the kubeconfig');
  const first: RequestOptions = {};
  await kc.applyToHTTPSOptions(first);
  return {
    server: cluster.server,
    tls: {
      ca: first.ca, cert: first.cert, key: first.key,
      rejectUnauthorized: first.rejectUnauthorized, servername: first.servername,
    },
    // applyToHTTPSOptions also builds an https.Agent each time; it is never
    // used, so it never opens a socket — only the headers are taken from it
    headers: async () => {
      const o: RequestOptions = {};
      await kc.applyToHTTPSOptions(o);
      return { ...((o.headers ?? {}) as Record<string, string>) };
    },
  };
}
```

- [ ] **Step 6: Rewrite `packages/operator/src/kube.ts`**

```ts
import type { kind } from 'kubernetes-fluent-client';
import type { IndexerStatus } from '@arckive/core';
import type { Indexer } from './kinds.js';
import type { KubeHttp } from './kubehttp.js';

export interface KubeApi {
  getConfigMap(namespace: string, name: string): Promise<kind.ConfigMap | null>;
  getSecret(namespace: string, name: string): Promise<kind.Secret | null>;
  applyConfigMap(cm: kind.ConfigMap): Promise<void>;
  applyServiceAccount(sa: kind.ServiceAccount): Promise<void>;
  applyRole(role: kind.Role): Promise<void>;
  applyRoleBinding(rb: kind.RoleBinding): Promise<void>;
  applyDeployment(d: kind.Deployment): Promise<void>;
  patchIndexerStatus(namespace: string, name: string, status: IndexerStatus): Promise<void>;
  listIndexers(): Promise<Indexer[]>;
}

// Server-side apply's field manager. kubernetes-fluent-client applied as
// "pepr"; with force=true the first apply under this name takes the fields
// over, and since the operator applies the same objects none is dropped.
const FIELD_MANAGER = 'arckive-operator';

const PLURAL: Readonly<Record<string, string>> = {
  ConfigMap: 'configmaps', Secret: 'secrets', ServiceAccount: 'serviceaccounts',
  Role: 'roles', RoleBinding: 'rolebindings', Deployment: 'deployments', Indexer: 'indexers',
};

export function objectPath(apiVersion: string, kindName: string, namespace: string, name?: string): string {
  const plural = PLURAL[kindName];
  if (!plural) throw new Error(`no API path for kind ${kindName}`);
  const base = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
  const ns = encodeURIComponent(namespace);
  return `${base}/namespaces/${ns}/${plural}${name ? `/${encodeURIComponent(name)}` : ''}`;
}

interface Applicable {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
}

export function createKubeApi(http: KubeHttp): KubeApi {
  const apply = async (obj: Applicable): Promise<void> => {
    const { apiVersion, kind: kindName, metadata } = obj;
    if (!apiVersion || !kindName || !metadata?.name || !metadata.namespace) {
      throw new Error('apply needs apiVersion, kind, metadata.name and metadata.namespace');
    }
    // JSON is YAML: the apply-patch content type takes it as is
    await http.patch(
      `${objectPath(apiVersion, kindName, metadata.namespace, metadata.name)}?fieldManager=${FIELD_MANAGER}&force=true`,
      'application/apply-patch+yaml',
      obj,
    );
  };
  return {
    getConfigMap: async (ns, name) => (await http.get(objectPath('v1', 'ConfigMap', ns, name))) as kind.ConfigMap | null,
    getSecret: async (ns, name) => (await http.get(objectPath('v1', 'Secret', ns, name))) as kind.Secret | null,
    applyConfigMap: apply,
    applyServiceAccount: apply,
    applyRole: apply,
    applyRoleBinding: apply,
    applyDeployment: apply,
    async patchIndexerStatus(namespace, name, status) {
      // a merge patch of the status subresource, as before
      await http.patch(
        `${objectPath('arckive.org/v1alpha1', 'Indexer', namespace, name)}/status`,
        'application/merge-patch+json',
        { status },
      );
    },
    async listIndexers() {
      const list = (await http.get('/apis/arckive.org/v1alpha1/indexers')) as { items?: Indexer[] } | null;
      return list?.items ?? [];
    },
  };
}
```

- [ ] **Step 7: Wire it in `main.ts`**

Replace `import { createKubeApi } from './kube.js';` with:
```ts
import { createKubeApi } from './kube.js';
import { connectionFromKubeConfig, createKubeHttp } from './kubehttp.js';
```
and the deps line with:
```ts
  // one keep-alive client for every get/apply/patch (kubehttp.ts); the
  // fluent client below is used only for the watch
  const kubeHttp = createKubeHttp(await connectionFromKubeConfig());
  const deps: ReconcileDeps = { kube: createKubeApi(kubeHttp), workerImage, log };
```
and in `shutdown`, after `watcher.close();`: `kubeHttp.close();`.

- [ ] **Step 8: Run the operator suite and lint**

Run: `corepack pnpm --filter @arckive/operator exec tsc --noEmit -p tsconfig.json && corepack pnpm --filter @arckive/operator exec vitest run && corepack pnpm lint`
Expected: PASS; `reconcile.test.ts` is unchanged and passes (it fakes `KubeApi`).

- [ ] **Step 9: Commit**

```bash
git add packages/operator/src/kubehttp.ts packages/operator/src/kube.ts packages/operator/src/main.ts \
  packages/operator/test/kube.test.ts packages/operator/package.json pnpm-lock.yaml
git commit -m "fix(operator): one keep-alive Kubernetes client instead of a new connection per request

kubernetes-fluent-client builds a new undici Agent with a 10-minute
keep-alive for every request; reproduced locally: 30 requests, 30
connections. The watch stays on the library.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 9: Docs

**Files:**
- Modify: `CLAUDE.md` ("Insights", "Ingest loop", "Database schema and naming", "Operator reconciliation", "Runtime interfaces" metric list)
- Modify: `README.md` (insights section, storage notes, metric list)
- Modify: `manifests/arc-mainnet/k8s/explorer.yaml` (`storage.addressIndexes: true`)

**Interfaces:** none (text).

- [ ] **Step 1: CLAUDE.md — Insights**

Replace the bullet that begins "Insights share the RPC budget with ingest and must stay second:" (through "Do not add concurrency on this path.") with:

```markdown
- Insight reads go through `RpcPool` (`worker/src/rpcpool.ts`, Radar's
  `rpc.py` model): JSON-RPC batches of up to 20 calls, **one request in
  flight** across the pool, endpoints tried in config order. A rate-limited
  or failed endpoint rests (5 s doubling to 60 s, cleared on the next
  answer) and its pacer backs off; a call one endpoint refuses (beamrpc's
  "Archive requests require a personal token", a node that has not seen the
  block) moves to the next endpoint without resting the first; a response
  over viem's size limit is halved on the same endpoint. Endpoints:
  `spec.insights.rpc`, else the last http entry of `network.rpc`
  (`insightsRpc`); a ws endpoint is asked one call per request. Rounds still
  run only while ingest is `Live`, and while ingest is `Degraded` the
  endpoints it shares are slowed (`backOffShared`). A round whose model
  call fails is kept and only the model call is retried (`prepareRound` /
  `finishRound`): a gate outage must cost no RPC. Do not add a second
  request in flight on this path.
- `spec.insights.startBlock`: omitted = the indexer's start; ≥ 0 = that
  block; negative = that many blocks before the head **when the insight
  loop first runs** (written by the first round, `initInsightsCursor`). The
  insights cursor is written once per schema; later edits change nothing.
```

Replace "`txcontext.ts` (per block: `getBlock(full)` + `getBlockReceipts`; `factory()` per pool, `getCode` per party, `symbol()`/`decimals()`), `pacer.ts`," with "`txcontext.ts` (per block: `getBlock(full)` + `getBlockReceipts`; `factory()` per pool, `getCode` per party, all through `rpcpool.ts`; `symbol()`/`decimals()` at start-up on ingest's client), `pacer.ts` (per pool endpoint),".

- [ ] **Step 2: CLAUDE.md — Ingest loop, schema, operator, metrics**

- "Ingest loop": append to the paragraph that starts "`runOnce` reads the cursor": "A `Live` worker whose range reaches the head stays `Live`; `Backfilling` means one round cannot reach the head (or the worker is starting or recovering). Do not set `Backfilling` on every round again: it pauses insights."
- "Database schema and naming": add a bullet after the `_addresses` bullet:
  ```markdown
  - With `storage.addressIndexes`, every `address` param gets
    `"<table>_<p>_id_idx" (<p>_id, block_number, log_index)` in place of the
    single-column index — "latest rows of this address" by keyset. The
    `_meta` key `address_indexes` fixes it for the schema's life; a schema
    from before the key counts as `'false'` (`LEGACY_META`), and `_meta` is
    checked before any table DDL runs.
  ```
- "Control tables per schema": `_meta` (layout + `contract:<table>` + `partition_blocks` + `address_indexes`).
- "Operator reconciliation": replace the first bullet with:
  ```markdown
  - `reconcile` is watch-driven plus a periodic resync (`RESYNC_INTERVAL_MS`,
    default 300000), through `ReconcileGate` (`operator/src/gate.ts`): a
    `MODIFIED` event reconciles only when `metadata.generation` changed —
    worker status patches every 10 s do not — and an Indexer has at most one
    reconcile running plus one queued rerun. A failed reconcile is retried on
    the next event. Deleted CRs are ignored — `ownerReferences` handle cleanup.
  - Gets, applies and status patches go through `operator/src/kubehttp.ts`,
    one keep-alive agent per process. kubernetes-fluent-client opens a new
    connection with a 10-minute keep-alive per request (the v3 OOM); it is
    used for the watch only. Do not route other calls back through it.
  ```
- "Runtime interfaces": add `insights_rpc_requests_total{endpoint,outcome}` to the metric list after `insights_errors_total{stage}`.

- [ ] **Step 3: README.md**

- Replace the paragraph that starts "Insights also share your RPC endpoints with ingest" (through "(for a tail-mode or negative `startBlock`, that boot's head).") with:

```markdown
Insight reads (`eth_getBlockByNumber` + `eth_getBlockReceipts` per block —
the endpoint must support the latter — `factory()` per new pool, `eth_getCode`
per new party) go out as JSON-RPC batches of up to 20 calls, one request at a
time, and only while ingest is `Live`. List endpoints for them in
`insights.rpc` (http(s), in priority order); without it they use the last
`http(s)` entry of `network.rpc`. An endpoint that rate-limits or fails rests
for 5 s, doubling to 60 s, while the next one carries the load, and a call one
endpoint refuses is asked of the next. Arc mainnet's public RPC has a
per-minute quota that ingest alone runs into, so give insights endpoints of
their own. The header Secret must hold one line of printable ASCII (a
trailing newline is dropped).

Lanes start at `insights.startBlock`: omitted, at the indexer's own start;
a block number, there; a negative number, that many blocks before the head
at the moment insights first run — for a full-history indexer, that is once
the backfill has caught up. It takes effect once per schema.
```

- In the YAML example under "insights:", add:
```yaml
    rpc: ["https://rpc.example-a.com", "https://rpc.example-b.com"]   # optional; insight reads only
    startBlock: -2000                                                   # optional; lanes from 2,000 blocks before the head
```
- Storage notes: after the partition bullet add:
```markdown
- `spec.storage.addressIndexes: true` indexes every address parameter as
  `(<param>_id, block_number, log_index)`, so "the latest rows of this
  address" reads an index instead of sorting all of that address's rows.
  Like `partitionBlocks` it is fixed when the schema is created.
```
  and in the `_meta` bullet, add `address_indexes` to the list of fixed keys.
- Metric list: add `` `arckive_insights_rpc_requests_total{endpoint,outcome}` `` after `arckive_insights_errors_total{stage}`.

- [ ] **Step 4: The explorer manifest**

In `manifests/arc-mainnet/k8s/explorer.yaml`, under `storage:` add:

```yaml
    # "latest movements of this address" for the explorer's address pages;
    # fixed when the schema is created
    addressIndexes: true
```

- [ ] **Step 5: Check and commit**

Run: `corepack pnpm -r build && corepack pnpm lint && corepack pnpm -r test`
Expected: all PASS.

```bash
git add CLAUDE.md README.md manifests/arc-mainnet/k8s/explorer.yaml
git commit -m "docs: insight RPC pool, insights.startBlock, address indexes, operator gate and client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 10: Real test on k3d (needs the user's go-ahead)

**Files:**
- Create: `manifests/arc-mainnet/k8s/postgres.yaml` (kept: the explorer's database)
- Scratch (not committed): `<scratchpad>/a2/{throughput.yaml,laya-stub.yaml,sample.sh}`
- Modify: `docs/superpowers/specs/2026-10-08-arckive-for-explorer-design.md` (a "Measured" section)

**Interfaces:** none.

- [ ] **Step 1: Ask before touching the cluster**

Stop and ask the user: "A2 is implemented and tested. The real test needs the k3d `arckive` cluster restarted, a Postgres with a 100 Gi volume on this Mac, and three Indexers: the explorer's own (kept, full-history backfill on rpc.mainnet.arc.io for several hours), a throughput test Indexer with a Laya stub, and one testnet Indexer. OK to start?" Do nothing below until the user says yes. Also check free disk: `df -h /` and Docker Desktop's disk limit; the explorer's history is ~16 GB and grows ~0.6 GB/day.

- [ ] **Step 2: Cluster, images, operator**

```bash
k3d cluster start arckive
docker build --target worker -t arckive-worker:a2 .
docker build --target operator -t arckive-operator:a2 .
k3d image import arckive-worker:a2 arckive-operator:a2 -c arckive
kubectl apply -f charts/arckive/crds/indexer.yaml
helm upgrade --install arckive charts/arckive -n arckive-system --create-namespace \
  --set image.tag=a2 --set workerImage.tag=a2
kubectl -n arckive-system rollout status deploy -l app.kubernetes.io/name=arckive-operator --timeout=120s
```
(If the release has another name or namespace, `helm list -A` shows it; reuse it.)

- [ ] **Step 3: The explorer's Postgres (kept)**

Create `manifests/arc-mainnet/k8s/postgres.yaml`:

```yaml
# The explorer's database: PostgreSQL 17 on a local-path volume. The
# password Secret is created by hand (never committed):
#   kubectl create secret generic pg-explorer-auth --from-literal=password=<random>
# and the worker's DSN Secret from it:
#   kubectl create secret generic pg-dsn \
#     --from-literal=url=postgres://arckive:<random>@pg-explorer:5432/explorer
apiVersion: v1
kind: Service
metadata:
  name: pg-explorer
spec:
  selector: { app: pg-explorer }
  ports: [{ port: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg-explorer
spec:
  serviceName: pg-explorer
  replicas: 1
  selector:
    matchLabels: { app: pg-explorer }
  template:
    metadata:
      labels: { app: pg-explorer }
    spec:
      containers:
        - name: postgres
          image: postgres:17-alpine
          args: ["-c", "shared_buffers=512MB", "-c", "max_wal_size=4GB"]
          env:
            - { name: POSTGRES_USER, value: arckive }
            - { name: POSTGRES_DB, value: explorer }
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: pg-explorer-auth, key: password } }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          ports: [{ containerPort: 5432 }]
          volumeMounts: [{ name: data, mountPath: /var/lib/postgresql/data }]
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "arckive", "-d", "explorer"] }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: local-path
        resources: { requests: { storage: 100Gi } }
```

Create the two Secrets by hand as the header comment says (generate the password with `openssl rand -hex 24`; do not echo it), then `kubectl apply -f manifests/arc-mainnet/k8s/postgres.yaml` and wait for ready.

- [ ] **Step 4: Laya stub and the throughput Indexer (scratch)**

`<scratchpad>/a2/laya-stub.yaml` — a gate stub answering at once:

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: laya-stub }
data:
  stub.py: |
    import json, zlib
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    LANES = ["payment", "swap", "bridge", "liquidity", "vault", "lending", "signed_payment"]
    class H(BaseHTTPRequestHandler):
        def _send(self, obj):
            body = json.dumps(obj).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
        def do_GET(self): self._send({"model": "stub"})
        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["content-length"])))
            out = []
            for s in req["states"]:
                lane = LANES[zlib.crc32(s.encode()) % len(LANES)]
                out.append({"answers": {"lane": {"choice": lane, "probabilities": {lane: 0.9}}}})
            self._send({"results": out})
        def log_message(self, *a): pass
    ThreadingHTTPServer(("", 8080), H).serve_forever()
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: laya-stub }
spec:
  selector: { matchLabels: { app: laya-stub } }
  template:
    metadata: { labels: { app: laya-stub } }
    spec:
      containers:
        - name: stub
          image: python:3.12-alpine
          command: ["python", "/app/stub.py"]
          volumeMounts: [{ name: app, mountPath: /app }]
      volumes: [{ name: app, configMap: { name: laya-stub } }]
---
apiVersion: v1
kind: Service
metadata: { name: laya-stub }
spec:
  selector: { app: laya-stub }
  ports: [{ port: 80, targetPort: 8080 }]
```

`<scratchpad>/a2/throughput.yaml`: copy `manifests/arc-mainnet/k8s/explorer.yaml`, then change `metadata.name` to `arc-throughput`, both contracts' `startBlock` to `-3000`, `network.rpc` to `["https://rpc.blockdaemon.mainnet.arc.io"]`, remove `storage.addressIndexes`, and add:

```yaml
  insights:
    laya: { url: "http://laya-stub" }
    rpc: ["https://rpc.beamrpc.com", "https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.mainnet.arc.io"]
    startBlock: -2000
```

Apply: `kubectl apply -f <scratchpad>/a2/laya-stub.yaml -f <scratchpad>/a2/throughput.yaml -f manifests/arc-mainnet/k8s/explorer.yaml`, plus one testnet Indexer: `manifests/arc-testnet/k8s/usdc-abi-configmap.yaml` and `manifests/arc-testnet/k8s/indexer.yaml` (its DSN Secret name is in that file; create it pointing at the same Postgres, database `explorer`). Check `kubectl get indexers` shows three, and the worker Deployments pull `arckive-worker:a2` with `imagePullPolicy: IfNotPresent` (patch the Deployments if not).

- [ ] **Step 5: Measure goals 2 and 6 (catch-up), then 1 and 3 (live, one hour)**

`<scratchpad>/a2/sample.sh` — every 5 s, the throughput worker's ingest cursor, insights cursor and `insights_blocks_behind`:

```bash
#!/usr/bin/env bash
# usage: sample.sh <seconds> > samples.tsv
set -euo pipefail
POD=$(kubectl get pod -l app.kubernetes.io/instance=arc-throughput -o name | head -1)
end=$(( $(date +%s) + $1 ))
while [ "$(date +%s)" -lt "$end" ]; do
  m=$(kubectl exec "$POD" -- wget -qO- localhost:9090/metrics)
  behind=$(awk '/^arckive_insights_blocks_behind/ {print $2}' <<<"$m")
  rate=$(awk '/^arckive_insights_rpc_requests_total/ {print $1"="$2}' <<<"$m" | tr '\n' ' ')
  cur=$(kubectl exec -i statefulset/pg-explorer -- psql -U arckive -d explorer -tAc \
    "select (select last_block from idx_arc_throughput._cursor),(select last_block from idx_arc_throughput._insights_cursor)")
  printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$cur" "$behind" "$rate"
  sleep 5
done
```

(Verify the pod label with `kubectl get pods --show-labels` first; `wget` must exist in the worker image — if not, port-forward 9090 and use `curl` from the host.)

Run it for the catch-up (from when ingest goes `Live` until `insights_blocks_behind` < 20) and then for 3,600 s. Compute from the TSV:
- goal 6: the insights cursor did not move before ingest reached the head, and then started ~2,000 behind;
- goal 2: blocks advanced per second by the insights cursor while ≥ 50 behind ÷ chain blocks per second (ingest cursor delta over the same window) ≥ 3;
- goal 1: p95 of `insights_blocks_behind` over the hour ≤ 10;
- goal 3: `rate_limited` ÷ all requests over the hour < 1%.

- [ ] **Step 6: Measure goal 5 (operator, two hours)**

Every minute for 2 h: `kubectl -n arckive-system get pod -l app.kubernetes.io/name=arckive-operator -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}'` and `kubectl -n arckive-system top pod`; at the end count `reconcile done` lines in `kubectl -n arckive-system logs deploy/<operator>`. Pass: 0 restarts, memory flat after the first 10 min (± 10%), reconcile lines ≈ start + 3 Indexers × 24 resyncs.

- [ ] **Step 7: Measure goal 7 (once the explorer table holds ≥ 5M rows)**

```sql
-- the busiest sender
SELECT from_id, count(*) FROM idx_arc_explorer.usdc_transfer GROUP BY 1 ORDER BY 2 DESC LIMIT 1;
EXPLAIN (ANALYZE, BUFFERS)
SELECT block_number, log_index FROM idx_arc_explorer.usdc_transfer
WHERE from_id = <id> ORDER BY block_number DESC, log_index DESC LIMIT 25;
-- bytes per row of the address indexes
SELECT sum(pg_relation_size(i.indexrelid))::numeric / (SELECT count(*) FROM idx_arc_explorer.usdc_transfer)
FROM pg_partition_tree('idx_arc_explorer.usdc_transfer') p
JOIN pg_index i ON i.indrelid = p.relid
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname LIKE '%from_id%' OR c.relname LIKE '%to_id%';
```

Pass: execution < 50 ms, an index scan backward, no Sort node.

- [ ] **Step 8: Record and clean up**

Add a "## Measured (k3d, <date>)" section to the spec with each goal's number and pass/fail, the index bytes per row, and anything that surprised. Then delete the scratch Indexer and its data: `kubectl delete indexer arc-throughput`, `kubectl delete -f <scratchpad>/a2/laya-stub.yaml`, and `DROP SCHEMA idx_arc_throughput CASCADE` (test data only). Keep `arc-explorer`, `pg-explorer` and the testnet Indexer running. Commit:

```bash
git add manifests/arc-mainnet/k8s/postgres.yaml docs/superpowers/specs/2026-10-08-arckive-for-explorer-design.md
git commit -m "docs: A2 measured on k3d; the explorer's Postgres manifest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

If a goal fails, do not tune blindly: report the numbers to the user with what they point at, and decide together.
