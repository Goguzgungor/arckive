# Arckive storage layout 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Arckive's storage compact (bytea, no redundant columns), range-partitioned and batch-written, read block times from logs, survive provider range caps, and index Arc's native USDC — so a whole-history explorer fits a managed Postgres.

**Architecture:** `@arckive/core` owns the pure parts — DDL for layout 2 (event tables, `_blocks`, `_insights`, views), partition naming, value encoding, known tokens. `@arckive/worker` owns the side effects — layout check and bootstrap, one `unnest` INSERT per table per commit, a per-process partition memo, block times from logs, an adaptive getLogs span. The operator only gains the `storage.partitionBlocks` CRD field.

**Tech Stack:** TypeScript ESM (NodeNext, strict, verbatimModuleSyntax), zod, viem 2.54, node-postgres (`pg`), vitest, testcontainers (postgres:17-alpine), anvil/foundry, Helm, k3d.

**Spec:** `docs/superpowers/specs/2026-10-07-arckive-storage-v2-design.md`

## Global Constraints

- Relative imports carry `.js`; type-only imports use `import type`; env vars use bracket notation (`process.env['X']`).
- All identifiers are double-quoted; all values go through parameters. No string-built values in SQL.
- Repository language is English (code, comments, commits, docs).
- Comments explain *why*; keep the existing comment density, never strip existing why-comments.
- Named error classes for domain failures (`LayoutError`, `NamingError`, …).
- Dependency direction: `operator → core`, `worker → core`; core has no K8s/Postgres/RPC deps.
- `STORAGE_LAYOUT = '2'`; partition `n` of table `t` is `t_p<n>` covering `[n·P, (n+1)·P)`; `P` = `storage.partitionBlocks`, default `2_000_000`, minimum `10_000`.
- Event table key: `PRIMARY KEY (block_number, log_index)`; inserts `ON CONFLICT (block_number, log_index) DO NOTHING`.
- `_ingested_at` stays (benchmarks derive freshness from it).
- Native USDC: `0xfffffffffffffffffffffffffffffffffffffffe`, `USDC`, 18 decimals, chainIds 5042 (Arc mainnet) and 5042002 (Arc testnet).
- Run `corepack pnpm -r build` before tests (`pnpm` is not on PATH; use `corepack pnpm`). Worker DB tests need Docker; pipeline tests need anvil.
- Commits: Conventional Commits, ending with
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg
  ```
- Between Task 2 and Task 4 the core layout has changed but the worker has not caught up: worker tests are expected to fail in that window and only that window. Every task's own package suite must pass.

## Review Focus

1. **A rolled-back commit whose batch created a partition** — the next commit must create it again, not assume it exists (Task 4 test "rolled-back batch").
2. **A getLogs error that is a rate limit, worded like a cap** ("Too many requests") — must keep the backoff path, not shrink the span (Task 5 classifier test).
3. **A batch of 0 rows** (empty range) — commit must still advance the cursor and send no table INSERT (Task 4 test "empty batch").
4. **Logs where only some carry `blockTimestamp`** (mixed or missing) — fall back to `getBlockTimes` for the whole batch, never write a wrong time (Task 5 unit test).
5. **A ruled insight with protocol `''` and no model** — stored as `protocol NULL`, sentence with model `''`, view shows `model NULL` (Task 6 test).

---

### Task 1: `storage.partitionBlocks` through CRD, zod and worker config

**Files:**
- Modify: `charts/arckive/crds/indexer.yaml` (spec.storage.properties)
- Modify: `packages/core/src/crd.ts` (IndexerSpecSchema.storage, renderWorkerConfig)
- Modify: `packages/core/src/config.ts` (WorkerConfigSchema)
- Test: `packages/core/test/crd.test.ts`, `packages/core/test/config.test.ts`, `packages/operator/test/crd-manifest.test.ts`
- Regenerate: `install.yaml` (via `scripts/build-install.sh`)

**Interfaces:**
- Produces: `WorkerConfig['storage']['partitionBlocks']: number` (default 2_000_000), `IndexerSpec['storage']['partitionBlocks']: number`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/crd.test.ts`, inside `describe('IndexerSpecSchema')`, add:

```ts
  it('storage.partitionBlocks defaults to 2,000,000 and rejects less than 10,000', () => {
    expect(IndexerSpecSchema.parse(raw).storage.partitionBlocks).toBe(2_000_000);
    const small = { ...raw, storage: { ...raw.storage, partitionBlocks: 9_999 } };
    expect(() => IndexerSpecSchema.parse(small)).toThrow();
  });

  it('renderWorkerConfig passes storage.partitionBlocks to the worker', () => {
    const spec = IndexerSpecSchema.parse({ ...raw, storage: { ...raw.storage, partitionBlocks: 50_000 } });
    expect(renderWorkerConfig('x', spec).storage).toEqual({ partitionBlocks: 50_000 });
  });
```

In `packages/core/test/config.test.ts` add (import `parseWorkerConfig` if not imported):

```ts
it('worker config defaults storage.partitionBlocks to 2,000,000', () => {
  const cfg = parseWorkerConfig({
    indexerName: 'x',
    network: { chainId: 1, rpc: ['http://127.0.0.1:1'] },
    contracts: [{ name: 'a', address: `0x${'ab'.repeat(20)}` }],
  });
  expect(cfg.storage.partitionBlocks).toBe(2_000_000);
});
```

In `packages/operator/test/crd-manifest.test.ts` add inside the describe:

```ts
  it('storage.partitionBlocks matches the zod default and minimum', () => {
    const storage = v.schema.openAPIV3Schema.properties.spec.properties['storage'] as {
      properties: Record<string, { type: string; minimum?: number; default?: number }>;
    };
    expect(storage.properties['partitionBlocks']).toEqual({ type: 'integer', minimum: 10000, default: 2000000 });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/core test -- crd config` and `corepack pnpm --filter @arckive/operator test -- crd-manifest`
Expected: FAIL (`partitionBlocks` undefined / missing in CRD).

- [ ] **Step 3: Implement**

`packages/core/src/config.ts` — add to `WorkerConfigSchema` after `polling`:

```ts
  // Rows are range-partitioned by block_number, partitionBlocks blocks per
  // partition: vacuum and index builds stay per range, and a retention
  // window, if one is ever wanted, is a DROP TABLE.
  storage: z
    .object({ partitionBlocks: z.number().int().min(10_000).default(2_000_000) })
    .default({}),
```

`packages/core/src/crd.ts` — in `IndexerSpecSchema.storage` add the field next to `external`:

```ts
    partitionBlocks: z.number().int().min(10_000).default(2_000_000),
```

and in `renderWorkerConfig`, after `polling: spec.polling,`:

```ts
    storage: { partitionBlocks: spec.storage.partitionBlocks },
```

`charts/arckive/crds/indexer.yaml` — under `spec.storage.properties`, as a sibling of `mode:` (20-space indent, same as `mode:`):

```yaml
                    partitionBlocks:
                      type: integer
                      minimum: 10000
                      default: 2000000
                      description: "Blocks per range partition of every table (storage layout 2)"
```

Then fix the operator test expectation if the description is present: change the expected object in the operator test to include `description: 'Blocks per range partition of every table (storage layout 2)'`.

- [ ] **Step 4: Run tests and regenerate install.yaml**

Run: `corepack pnpm -r build && corepack pnpm --filter @arckive/core test && corepack pnpm --filter @arckive/operator test`
Expected: PASS.
Run: `scripts/build-install.sh && git diff --stat install.yaml`
Expected: `install.yaml` shows the new CRD lines only.

- [ ] **Step 5: Commit**

```bash
git add charts/arckive/crds/indexer.yaml packages/core/src/crd.ts packages/core/src/config.ts packages/core/test packages/operator/test install.yaml
git commit -m "feat: storage.partitionBlocks in the CRD and worker config"
```

---

### Task 2: Layout-2 DDL for event tables, `_blocks` and partitions (core)

**Files:**
- Modify: `packages/core/src/naming.ts` (export `assertPgIdentifier`)
- Modify: `packages/core/src/ddl.ts`
- Create: `packages/core/src/partitions.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/ddl.test.ts`, create `packages/core/test/partitions.test.ts`

**Interfaces:**
- Produces (exported from `@arckive/core`):
  - `STORAGE_LAYOUT: '2'`
  - `interface ColumnSpec { name: string; pgType: string }`
  - `COMMON_COLUMNS: ReadonlyArray<ColumnSpec>` = block_number bigint, block_time timestamptz, tx_hash bytea, tx_index integer, log_index integer
  - `BLOCK_COLUMNS: ReadonlyArray<ColumnSpec>` = block_number bigint, block_hash bytea, block_time timestamptz
  - `interface TableSpec { schema: string; table: string; columns: ColumnSpec[]; statements: string[] }` (`columns` = every column a row supplies, insert order, without `_ingested_at`)
  - `buildEventTable(schema, def): TableSpec`, `buildControlTables(schema): string[]`, `pgTypeFor(abiType): string` (address → `bytea`)
  - `partitionOf(block: bigint, size: bigint): bigint`, `partitionName(table: string, n: bigint): string`, `partitionDdl(schema: string, table: string, n: bigint, size: bigint): string`
  - `assertPgIdentifier(id: string): string` (throws `NamingError`)

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/partitions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NamingError, partitionDdl, partitionName, partitionOf } from '../src/index.js';

describe('partitions', () => {
  it('maps a block to its partition', () => {
    expect(partitionOf(0n, 1000n)).toBe(0n);
    expect(partitionOf(999n, 1000n)).toBe(0n);
    expect(partitionOf(1000n, 1000n)).toBe(1n);
    expect(partitionOf(24_747_528n, 2_000_000n)).toBe(12n);
  });

  it('names and creates a partition over [n·P, (n+1)·P)', () => {
    expect(partitionName('usdc_transfer', 12n)).toBe('usdc_transfer_p12');
    expect(partitionDdl('idx_x', 'usdc_transfer', 12n, 2_000_000n)).toBe(
      'CREATE TABLE IF NOT EXISTS "idx_x"."usdc_transfer_p12" PARTITION OF "idx_x"."usdc_transfer" ' +
        'FOR VALUES FROM (24000000) TO (26000000)',
    );
  });

  it('refuses a partition name over 63 bytes', () => {
    expect(() => partitionName('t'.repeat(60), 1234n)).toThrow(NamingError);
  });
});
```

Replace the `pgTypeFor`, `buildEventTable` and `buildControlTables` describes in `packages/core/test/ddl.test.ts` with (keep the `eventColumns` describe; keep its existing `ABI`/defs setup at the top of the file):

```ts
describe('pgTypeFor', () => {
  it('maps types according to layout 2', () => {
    expect(pgTypeFor('address')).toBe('bytea');
    expect(pgTypeFor('bytes32')).toBe('bytea');
    expect(pgTypeFor('bytes')).toBe('bytea');
    expect(pgTypeFor('uint256')).toBe('numeric(78,0)');
    expect(pgTypeFor('int24')).toBe('numeric(78,0)');
    expect(pgTypeFor('bool')).toBe('boolean');
    expect(pgTypeFor('string')).toBe('text');
    expect(pgTypeFor('uint256[]')).toBe('jsonb');
    expect(pgTypeFor('tuple')).toBe('jsonb');
  });

  it('unknown type throws DdlError', () => {
    expect(() => pgTypeFor('fixed128x18')).toThrow(DdlError);
  });
});

describe('buildEventTable (layout 2)', () => {
  const transfer = extractEventDefs('usdc', `0x${'ab'.repeat(20)}`, [{
    type: 'event', name: 'Transfer', inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  }])[0]!;
  const spec = buildEventTable('idx_x', transfer);

  it('lists the columns a row supplies, in insert order', () => {
    expect(spec.columns).toEqual([
      { name: 'block_number', pgType: 'bigint' },
      { name: 'block_time', pgType: 'timestamptz' },
      { name: 'tx_hash', pgType: 'bytea' },
      { name: 'tx_index', pgType: 'integer' },
      { name: 'log_index', pgType: 'integer' },
      { name: 'from', pgType: 'bytea' },
      { name: 'to', pgType: 'bytea' },
      { name: 'value', pgType: 'numeric(78,0)' },
    ]);
  });

  it('creates a partitioned table keyed by (block_number, log_index), without block_hash or contract_address', () => {
    const create = spec.statements[0]!;
    expect(create).toContain('CREATE TABLE IF NOT EXISTS "idx_x"."usdc_transfer"');
    expect(create).toContain('"tx_hash" bytea NOT NULL');
    expect(create).toContain('"_ingested_at" timestamptz NOT NULL DEFAULT now()');
    expect(create).toContain('PRIMARY KEY (block_number, log_index)');
    expect(create).toMatch(/\) PARTITION BY RANGE \(block_number\)$/);
    expect(create).not.toContain('block_hash');
    expect(create).not.toContain('contract_address');
  });

  it('indexes tx_hash with a hash index and indexed params with btree', () => {
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_tx_hash_idx" ON "idx_x"."usdc_transfer" USING hash (tx_hash)',
    );
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_from_idx" ON "idx_x"."usdc_transfer" ("from")',
    );
    expect(spec.statements.some((s) => s.includes('"usdc_transfer_value_idx"'))).toBe(false);
  });

  it('adds a _hex view that prints bytea as 0x text', () => {
    const view = spec.statements.find((s) => s.startsWith('CREATE OR REPLACE VIEW'))!;
    expect(view).toBe(
      'CREATE OR REPLACE VIEW "idx_x"."usdc_transfer_hex" AS SELECT "block_number", "block_time", ' +
        `'0x' || encode("tx_hash", 'hex') AS "tx_hash", "tx_index", "log_index", "_ingested_at", ` +
        `'0x' || encode("from", 'hex') AS "from", '0x' || encode("to", 'hex') AS "to", "value" ` +
        'FROM "idx_x"."usdc_transfer"',
    );
  });

  it('refuses a table whose partitions could not be named', () => {
    const long = extractEventDefs('a'.repeat(30), `0x${'ab'.repeat(20)}`, [{
      type: 'event', name: 'B'.repeat(27), inputs: [],
    }])[0]!;
    expect(() => buildEventTable('idx_x', long)).toThrow(NamingError);
  });
});

describe('buildControlTables (layout 2)', () => {
  it('schema, cursor, meta, dead letters and a partitioned _blocks', () => {
    const s = buildControlTables('idx_x');
    expect(s[0]).toBe('CREATE SCHEMA IF NOT EXISTS "idx_x"');
    expect(s.some((x) => x.includes('"idx_x"._cursor'))).toBe(true);
    expect(s.some((x) => x.includes('"idx_x"._meta'))).toBe(true);
    expect(s.some((x) => x.includes('"idx_x"._dead_letter'))).toBe(true);
    const blocks = s.find((x) => x.includes('"idx_x"._blocks'))!;
    expect(blocks).toContain('block_hash bytea NOT NULL');
    expect(blocks).toContain('PRIMARY KEY (block_number)');
    expect(blocks).toMatch(/PARTITION BY RANGE \(block_number\)$/);
  });
});
```

Delete the v1-only tests in `ddl.test.ts`: "common columns + parameters + unique constraint…", "_ingested_at meta column: in CREATE + ALTER…", and the old "schema + three control tables". Keep "event parameter named _ingestedAt does not collide…" but update any assertion on `UNIQUE`/`ALTER` it makes so it only checks the column name `ingested_at` appears in `spec.columns`. Ensure the file imports `NamingError`, `DdlError`, `extractEventDefs`, `buildEventTable`, `buildControlTables`, `pgTypeFor` from `../src/index.js`.

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/core test -- ddl partitions`
Expected: FAIL (`partitionOf` not exported, `columns` undefined, etc.).

- [ ] **Step 3: Implement**

`packages/core/src/naming.ts` — export the existing guard (rename nothing): change `function assertPgIdentifier` to `export function assertPgIdentifier`.

Create `packages/core/src/partitions.ts`:

```ts
import { assertPgIdentifier } from './naming.js';

const q = (id: string) => `"${id}"`;

// Layout 2 range-partitions every row table by block_number in fixed spans:
// partition n holds [n·size, (n+1)·size). Fixed spans need no catalogue of
// boundaries — a block's partition is arithmetic — and a name that would be
// truncated past 63 bytes would make two partitions collide, so it throws.
export function partitionOf(block: bigint, size: bigint): bigint {
  return block / size;
}

export function partitionName(table: string, n: bigint): string {
  return assertPgIdentifier(`${table}_p${n}`);
}

export function partitionDdl(schema: string, table: string, n: bigint, size: bigint): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(partitionName(table, n))} PARTITION OF ${q(schema)}.${q(table)} ` +
    `FOR VALUES FROM (${n * size}) TO (${(n + 1n) * size})`
  );
}
```

Rewrite the layout parts of `packages/core/src/ddl.ts` (keep `DdlError`, `INGESTED_AT`, `eventColumns`, `EventColumn`; `buildInsightsTables` stays as is until Task 6):

```ts
import type { AbiEvent } from 'viem';
import type { EventDef } from './abi.js';
import { assertPgIdentifier, toSnakeCase } from './naming.js';

export class DdlError extends Error {}

// Storage layout 2: hashes and addresses are bytea, the block hash lives once
// per block in _blocks and the contract address once per table in _meta, and
// every row table is range-partitioned by block_number. A schema written by
// another layout is refused at bootstrap (worker db.ts), never mixed.
export const STORAGE_LAYOUT = '2';

export interface ColumnSpec {
  name: string;
  pgType: string;
}

export const COMMON_COLUMNS: ReadonlyArray<ColumnSpec> = [
  { name: 'block_number', pgType: 'bigint' },
  { name: 'block_time', pgType: 'timestamptz' },
  { name: 'tx_hash', pgType: 'bytea' },
  { name: 'tx_index', pgType: 'integer' },
  { name: 'log_index', pgType: 'integer' },
];

export const BLOCK_COLUMNS: ReadonlyArray<ColumnSpec> = [
  { name: 'block_number', pgType: 'bigint' },
  { name: 'block_hash', pgType: 'bytea' },
  { name: 'block_time', pgType: 'timestamptz' },
];

// _ingested_at is filled in by the DB (DEFAULT now()); decode does not produce it,
// so it is not in COMMON_COLUMNS but is reserved to avoid name collisions.
export const INGESTED_AT = '_ingested_at';
const RESERVED = new Set([...COMMON_COLUMNS.map((c) => c.name), INGESTED_AT]);
const q = (id: string) => `"${id}"`;

// The widest partition number checked at bootstrap: block 10^6 · partitionBlocks
// is far past any chain's head, so a table that passes never meets a partition
// name it cannot have.
const WIDEST_PARTITION = 999_999n;

export function pgTypeFor(abiType: string): string {
  if (abiType.endsWith(']')) return 'jsonb';
  if (abiType.startsWith('tuple')) return 'jsonb';
  // 20 bytes instead of 42 characters, compared through the index with a '\x…' literal
  if (abiType === 'address') return 'bytea';
  if (abiType === 'bool') return 'boolean';
  if (abiType === 'string') return 'text';
  if (/^bytes(\d+)?$/.test(abiType)) return 'bytea';
  if (/^u?int\d*$/.test(abiType)) return 'numeric(78,0)';
  throw new DdlError(`Unknown ABI type: ${abiType}`);
}
```

(`eventColumns` unchanged, using the new `RESERVED`.)

```ts
export interface TableSpec {
  schema: string;
  table: string;
  // every column a row supplies, in insert order; _ingested_at is the DB's
  columns: ColumnSpec[];
  statements: string[];
}

// For dashboards and exports: the same rows with hashes and addresses as 0x
// text. Filters belong on the base table — a predicate on these text columns
// cannot use the bytea indexes.
function hexView(schema: string, table: string, columns: ColumnSpec[]): string {
  const view = assertPgIdentifier(`${table}_hex`);
  const ordered = [
    ...columns.slice(0, COMMON_COLUMNS.length),
    { name: INGESTED_AT, pgType: 'timestamptz' },
    ...columns.slice(COMMON_COLUMNS.length),
  ];
  const select = ordered.map(({ name, pgType }) =>
    pgType === 'bytea' ? `'0x' || encode(${q(name)}, 'hex') AS ${q(name)}` : q(name),
  );
  return `CREATE OR REPLACE VIEW ${q(schema)}.${q(view)} AS SELECT ${select.join(', ')} FROM ${q(schema)}.${q(table)}`;
}

export function buildEventTable(schema: string, def: EventDef): TableSpec {
  assertPgIdentifier(`${def.tableName}_p${WIDEST_PARTITION}`);
  const params = eventColumns(def.event);
  const columns: ColumnSpec[] = [
    ...COMMON_COLUMNS,
    ...params.map((c) => ({ name: c.name, pgType: pgTypeFor(c.abiType) })),
  ];
  const t = `${q(schema)}.${q(def.tableName)}`;
  const lines = [
    ...COMMON_COLUMNS.map((c) => `${q(c.name)} ${c.pgType} NOT NULL`),
    `${q(INGESTED_AT)} timestamptz NOT NULL DEFAULT now()`,
    ...params.map((c) => `${q(c.name)} ${pgTypeFor(c.abiType)}`),
    // logIndex is block-scoped, so the pair names a log chain-wide
    'PRIMARY KEY (block_number, log_index)',
  ];
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${t} (\n  ${lines.join(',\n  ')}\n) PARTITION BY RANGE (block_number)`,
    // lookups by transaction are equality only: a hash index keeps a 4-byte
    // code per row where a btree would keep the 33-byte hash
    `CREATE INDEX IF NOT EXISTS ${q(`${def.tableName}_tx_hash_idx`)} ON ${t} USING hash (tx_hash)`,
    ...params
      .filter((c) => c.indexed)
      .map((c) => `CREATE INDEX IF NOT EXISTS ${q(`${def.tableName}_${c.name}_idx`)} ON ${t} (${q(c.name)})`),
    hexView(schema, def.tableName, columns),
  ];
  return { schema, table: def.tableName, columns, statements };
}

export function buildControlTables(schema: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${q(schema)}`,
    `CREATE TABLE IF NOT EXISTS ${q(schema)}._cursor (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE TABLE IF NOT EXISTS ${q(schema)}._meta (
  key text PRIMARY KEY,
  value text NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS ${q(schema)}._dead_letter (
  id bigserial PRIMARY KEY,
  block_number bigint,
  tx_hash text,
  log_index integer,
  address text,
  topics jsonb,
  data text,
  error text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
)`,
    // One row per block that produced an indexed row: the block hash once,
    // instead of in every row of every table.
    `CREATE TABLE IF NOT EXISTS ${q(schema)}._blocks (
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL,
  block_time timestamptz NOT NULL,
  PRIMARY KEY (block_number)
) PARTITION BY RANGE (block_number)`,
  ];
}
```

`packages/core/src/index.ts` — export the new names:

```ts
export { NamingError, assertPgIdentifier, eventTableName, schemaName, toSnakeCase } from './naming.js';
export {
  BLOCK_COLUMNS,
  COMMON_COLUMNS,
  DdlError,
  STORAGE_LAYOUT,
  buildControlTables,
  buildEventTable,
  buildInsightsTables,
  eventColumns,
  pgTypeFor,
  type ColumnSpec,
  type EventColumn,
  type TableSpec,
} from './ddl.js';
export { partitionDdl, partitionName, partitionOf } from './partitions.js';
```

- [ ] **Step 4: Run tests**

Run: `corepack pnpm --filter @arckive/core build && corepack pnpm --filter @arckive/core test`
Expected: PASS (core). Worker tests are expected to fail until Task 4.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core)!: storage layout 2 DDL — bytea, partitions, _blocks, hex views"
```

---

### Task 3: Layout-2 row encoding and known tokens (core)

**Files:**
- Modify: `packages/core/src/decode.ts`
- Create: `packages/core/src/insights/tokens.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/decode.test.ts`, create `packages/core/test/tokens.test.ts`

**Interfaces:**
- Consumes: `COMMON_COLUMNS` names from Task 2.
- Produces:
  - `interface DecodedRow { tableName: string; blockHash: \`0x${string}\`; columns: Record<string, unknown> }` — `columns` holds `block_number` (decimal string), `block_time` (Date), `tx_hash` (Buffer), `tx_index`, `log_index`, then params (address/bytes → Buffer, ints → decimal string, arrays/tuples → JSON string, bool/string as is). No `block_hash`, no `contract_address`.
  - `toSqlValue(abiType, value)`: `address` → `Buffer` (20 bytes).
  - `NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe'`, `knownToken(chainId: number, address: string): TokenInfo | undefined`.

- [ ] **Step 1: Write the failing tests**

Replace the bodies in `packages/core/test/decode.test.ts` (keep its ABI/log fixtures; adjust names to what the file defines):

```ts
describe('toSqlValue', () => {
  it('bigint → string, address → 20-byte Buffer, bytes → Buffer, array → JSON string', () => {
    expect(toSqlValue('uint256', 5n)).toBe('5');
    expect(toSqlValue('address', '0xAbCd' + '00'.repeat(18))).toEqual(Buffer.from('abcd' + '00'.repeat(18), 'hex'));
    expect((toSqlValue('address', `0x${'11'.repeat(20)}`) as Buffer).length).toBe(20);
    expect(toSqlValue('bytes32', `0x${'ff'.repeat(32)}`)).toEqual(Buffer.from('ff'.repeat(32), 'hex'));
    expect(toSqlValue('uint256[]', [1n, 2n])).toBe('["1","2"]');
  });
});

describe('decodeLogToRow', () => {
  it('fills layout-2 columns; the block hash rides beside them', () => {
    const row = decodeLogToRow(def, log, new Date(1000));
    expect(row.blockHash).toBe(log.blockHash);
    expect(Object.keys(row.columns)).toEqual([
      'block_number', 'block_time', 'tx_hash', 'tx_index', 'log_index', 'from', 'to', 'value',
    ]);
    expect(row.columns['tx_hash']).toEqual(Buffer.from(log.transactionHash.slice(2), 'hex'));
    expect(row.columns['block_number']).toBe(log.blockNumber.toString());
  });
});
```

(Keep the existing "mismatched data throws DecodeError" test. If the file's fixture event is not a `Transfer(from,to,value)`, adjust the expected key list to that event's parameters.)

Create `packages/core/test/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NATIVE_USDC, knownToken } from '../src/index.js';

describe('knownToken', () => {
  it('names native USDC on Arc mainnet and testnet, in 18 decimals', () => {
    expect(knownToken(5042, NATIVE_USDC)).toEqual({ label: 'USDC', decimals: 18 });
    expect(knownToken(5042002, NATIVE_USDC.toUpperCase().replace('0X', '0x'))).toEqual({ label: 'USDC', decimals: 18 });
  });

  it('knows nothing about other chains or addresses', () => {
    expect(knownToken(1, NATIVE_USDC)).toBeUndefined();
    expect(knownToken(5042, `0x${'36'}${'00'.repeat(19)}`)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/core test -- decode tokens`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/core/src/decode.ts`:

```ts
export interface DecodedRow {
  tableName: string;
  // written once per block to _blocks, not into the event table
  blockHash: `0x${string}`;
  columns: Record<string, unknown>;
}

const hexBytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');

export function toSqlValue(abiType: string, value: unknown): unknown {
  if (abiType.endsWith(']') || abiType.startsWith('tuple')) {
    return JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  }
  if (abiType === 'address') return hexBytes(String(value));
  if (/^bytes(\d+)?$/.test(abiType)) return hexBytes(String(value));
  if (typeof value === 'bigint') return value.toString();
  return value;
}
```

and in `decodeLogToRow` replace the `columns` literal and the return:

```ts
  const columns: Record<string, unknown> = {
    block_number: log.blockNumber.toString(),
    block_time: blockTime,
    tx_hash: hexBytes(log.transactionHash),
    tx_index: log.transactionIndex,
    log_index: log.logIndex,
  };
  // … parameter loop unchanged …
  return { tableName: def.tableName, blockHash: log.blockHash, columns };
```

Create `packages/core/src/insights/tokens.ts`:

```ts
import type { TokenInfo } from './sentence.js';

// Token facts the chain cannot answer. Arc logs every native USDC movement —
// including the twin of every ERC-20 USDC transfer — as a Transfer from
// 0xff…fe, an address with no code: no symbol(), no decimals(). Its values are
// in USDC's native 18 decimals.
export const NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe';

const ARC: ReadonlyMap<string, TokenInfo> = new Map([[NATIVE_USDC, { label: 'USDC', decimals: 18 }]]);

const KNOWN_TOKENS: ReadonlyMap<number, ReadonlyMap<string, TokenInfo>> = new Map([
  [5042, ARC], // Arc mainnet
  [5042002, ARC], // Arc testnet
]);

export function knownToken(chainId: number, address: string): TokenInfo | undefined {
  return KNOWN_TOKENS.get(chainId)?.get(address.toLowerCase());
}
```

`packages/core/src/index.ts` — add:

```ts
export { NATIVE_USDC, knownToken } from './insights/tokens.js';
```

- [ ] **Step 4: Run tests**

Run: `corepack pnpm --filter @arckive/core build && corepack pnpm --filter @arckive/core test`
Expected: PASS (core, including the Radar parity test, which is unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core)!: layout-2 row encoding (bytea) and native USDC token info"
```

---

### Task 4: Worker writes layout 2 — layout check, partitions, one INSERT per table

**Files:**
- Modify: `packages/worker/src/db.ts`
- Modify: `packages/worker/src/pipeline.ts` (PipelineDeps.store, bootstrapIndexer, commitBatch call)
- Modify: `packages/worker/src/insightsdb.ts` (`readEventRows` hex-encodes bytea)
- Modify: `packages/worker/src/main.ts` (create the store)
- Test: rewrite `packages/worker/test/db.test.ts`; update `packages/worker/test/pipeline.test.ts`, `packages/worker/test/insights.test.ts`, `packages/worker/test/deadletter.test.ts` call sites

**Interfaces:**
- Consumes: Task 2 (`STORAGE_LAYOUT`, `BLOCK_COLUMNS`, `TableSpec.columns`, `buildEventTable`, `partitionDdl`, `partitionOf`), Task 3 (`DecodedRow.blockHash`, Buffer columns), Task 1 (`cfg.storage.partitionBlocks`).
- Produces (from `packages/worker/src/db.ts`):
  - `class LayoutError extends Error`
  - `class Partitions { constructor(schema: string, size: bigint); plan(tables: readonly string[], blocks: Iterable<bigint>): PlannedPartition[]; remember(planned: readonly PlannedPartition[]): void }`, `interface PlannedPartition { key: string; sql: string }`
  - `interface Store { schema: string; tables: ReadonlyMap<string, TableSpec>; partitions: Partitions }`
  - `createStore(schema: string, defs: EventDef[], partitionBlocks: number): Store`
  - `contractMeta(defs: EventDef[]): Record<string, string>` → `{ 'contract:<table>': '<address lowercase>' }`
  - `bootstrap(pool, schema, controlStatements, tables: TableSpec[], meta: Record<string, string>): Promise<void>`
  - `commitBatch(pool, store: Store, rows: DecodedRow[], deadLetters: DeadLetterEntry[], newCursor: bigint): Promise<number>`
  - `unnestInsert(qualifiedTable: string, columns: readonly ColumnSpec[], conflict: string): string`
  - `PipelineDeps.store: Store` (new, required)

- [ ] **Step 1: Write the failing tests**

Replace `packages/worker/test/db.test.ts` entirely:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildControlTables, extractEventDefs, type DecodedRow } from '@arckive/core';
import {
  LayoutError, bootstrap, commitBatch, contractMeta, createStore, getCursor, initCursor, type Store,
} from '../src/db.js';

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ABI = [
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
];
const SCHEMA = 'idx_demo';
const defs = extractEventDefs('usdc', ADDR, ABI);
const hex = (h: string) => Buffer.from(h.slice(2), 'hex');

function row(blockNumber: number, logIndex: number): DecodedRow {
  return {
    tableName: 'usdc_transfer',
    blockHash: `0x${'a'.repeat(64)}`,
    columns: {
      block_number: String(blockNumber),
      block_time: new Date('2026-07-03T00:00:00Z'),
      tx_hash: hex('0x' + 'b'.repeat(64)),
      tx_index: 0,
      log_index: logIndex,
      from: hex('0x' + '1'.repeat(40)),
      to: hex('0x' + '2'.repeat(40)),
      value: '100',
    },
  };
}

// counts every statement sent through clients of this pool
function countingPool(uri: string): { pool: pg.Pool; sent: { n: number } } {
  const sent = { n: 0 };
  const pool = new pg.Pool({ connectionString: uri });
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
      sent.n++;
      return query(...a);
    };
  });
  return { pool, sent };
}

describe('db (storage layout 2)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let store: Store;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    store = createStore(SCHEMA, defs, 1000);
    await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], contractMeta(defs));
    await initCursor(pool, SCHEMA, 9n);
  });

  it('bootstrap is idempotent and records the layout and each contract', async () => {
    await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], contractMeta(defs));
    const meta = await pool.query(`SELECT key, value FROM ${SCHEMA}._meta ORDER BY key`);
    expect(meta.rows).toEqual([
      { key: 'contract:usdc_transfer', value: ADDR.toLowerCase() },
      { key: 'layout', value: '2' },
    ]);
    expect(await getCursor(pool, SCHEMA)).toBe(9n);
  });

  it('refuses a schema written by layout 1', async () => {
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}._cursor (id smallint PRIMARY KEY, last_block bigint NOT NULL)`);
    await pool.query(`CREATE TABLE ${SCHEMA}._meta (key text PRIMARY KEY, value text NOT NULL)`);
    await expect(
      bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], contractMeta(defs)),
    ).rejects.toBeInstanceOf(LayoutError);
  });

  it('commitBatch is idempotent, writes _blocks and advances the cursor', async () => {
    expect(await commitBatch(pool, store, [row(10, 0), row(10, 1)], [], 10n)).toBe(2);
    expect(await commitBatch(pool, store, [row(10, 0), row(10, 1)], [], 10n)).toBe(0);
    expect(await getCursor(pool, SCHEMA)).toBe(10n);
    const r = await pool.query(`SELECT "from", tx_hash FROM ${SCHEMA}.usdc_transfer ORDER BY log_index`);
    expect(r.rows[0].from).toEqual(hex('0x' + '1'.repeat(40)));
    const blocks = await pool.query(`SELECT block_number, block_hash FROM ${SCHEMA}._blocks`);
    expect(blocks.rows).toEqual([{ block_number: '10', block_hash: hex('0x' + 'a'.repeat(64)) }]);
  });

  it('sends the same number of statements for 2 rows and for 200', async () => {
    const { pool: counted, sent } = countingPool(container.getConnectionUri());
    try {
      await commitBatch(counted, store, [row(20, 0), row(20, 1)], [], 20n); // creates the partitions
      sent.n = 0;
      await commitBatch(counted, store, [row(21, 0), row(21, 1)], [], 21n);
      const small = sent.n;
      sent.n = 0;
      await commitBatch(counted, store, Array.from({ length: 200 }, (_, i) => row(22, i)), [], 22n);
      expect(sent.n).toBe(small);
      expect(small).toBe(5); // BEGIN, _blocks, usdc_transfer, cursor, COMMIT
    } finally {
      await counted.end();
    }
  });

  it('an empty batch advances the cursor and inserts nothing', async () => {
    expect(await commitBatch(pool, store, [], [], 30n)).toBe(0);
    expect(await getCursor(pool, SCHEMA)).toBe(30n);
  });

  it('a batch across a partition boundary creates the next partition', async () => {
    await commitBatch(pool, store, [row(999, 0), row(1000, 0)], [], 1000n);
    const parts = await pool.query(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = $1 AND p.relname = 'usdc_transfer' ORDER BY 1`,
      [SCHEMA],
    );
    expect(parts.rows.map((x) => x.relname)).toEqual(['usdc_transfer_p0', 'usdc_transfer_p1']);
  });

  it('a rolled-back batch is not remembered as having made its partition', async () => {
    const bad = row(5000, 0);
    bad.columns['value'] = 'not a number';
    await expect(commitBatch(pool, store, [bad], [], 5000n)).rejects.toThrow();
    expect(await commitBatch(pool, store, [row(5000, 0)], [], 5000n)).toBe(1);
  });

  it('the _hex view prints 0x text', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    const r = await pool.query(`SELECT "from", tx_hash FROM ${SCHEMA}.usdc_transfer_hex`);
    expect(r.rows[0]).toEqual({ from: '0x' + '1'.repeat(40), tx_hash: '0x' + 'b'.repeat(64) });
  });

  it('dead letters are written in the same transaction', async () => {
    await commitBatch(pool, store, [], [{
      blockNumber: 11n, txHash: '0x' + 'c'.repeat(64), logIndex: 0,
      address: ADDR.toLowerCase(), topics: ['0xdead'], data: '0x01', error: 'decode error',
    }], 11n);
    const r = await pool.query(`SELECT error, topics FROM ${SCHEMA}._dead_letter`);
    expect(r.rows[0]).toEqual({ error: 'decode error', topics: ['0xdead'] });
    expect(await getCursor(pool, SCHEMA)).toBe(11n);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `corepack pnpm -r build && corepack pnpm --filter @arckive/worker test -- db.test`
Expected: FAIL (`createStore`, `LayoutError` not exported).

- [ ] **Step 3: Implement `db.ts`**

Replace `packages/worker/src/db.ts` with (keep `getCursor`, `initCursor`, `DeadLetterEntry` exactly as they are):

```ts
import pg from 'pg';
import {
  BLOCK_COLUMNS, STORAGE_LAYOUT, buildEventTable, partitionDdl, partitionOf,
  type ColumnSpec, type DecodedRow, type EventDef, type TableSpec,
} from '@arckive/core';

const q = (id: string) => `"${id}"`;

// A schema written by storage layout 1 has a _cursor and no layout row. Its
// tables cannot take layout-2 rows, and rewriting text into bytea in place is
// slower than re-indexing from the chain, so it is refused, never mixed.
export class LayoutError extends Error {}

async function assertLayout(client: pg.PoolClient, schema: string): Promise<void> {
  const r = await client.query(
    'SELECT to_regclass($1) IS NOT NULL AS has_cursor, to_regclass($2) IS NOT NULL AS has_meta',
    [`${q(schema)}._cursor`, `${q(schema)}._meta`],
  );
  if (!r.rows[0].has_cursor) return; // a fresh schema
  const layout: string | undefined = r.rows[0].has_meta
    ? (await client.query(`SELECT value FROM ${q(schema)}._meta WHERE key = 'layout'`)).rows[0]?.value
    : undefined;
  if (layout !== STORAGE_LAYOUT) {
    throw new LayoutError(
      `schema ${schema} uses storage layout ${layout ?? '1'}; drop the schema or rename the Indexer to re-index`,
    );
  }
}

export async function bootstrap(
  pool: pg.Pool,
  schema: string,
  controlStatements: string[],
  tables: TableSpec[],
  meta: Record<string, string>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertLayout(client, schema);
    for (const s of controlStatements) await client.query(s);
    for (const t of tables) for (const s of t.statements) await client.query(s);
    for (const [key, value] of Object.entries({ ...meta, layout: STORAGE_LAYOUT })) {
      await client.query(
        `INSERT INTO ${q(schema)}._meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value],
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

// getCursor, initCursor, DeadLetterEntry: unchanged

export interface PlannedPartition {
  key: string;
  sql: string;
}

// Which partitions this process has created. A partition is created inside
// the transaction that first writes to it and remembered only after that
// transaction commits: a rolled-back batch leaves nothing believed to exist,
// and the steady state sends no DDL at all.
export class Partitions {
  private readonly made = new Set<string>();

  constructor(
    readonly schema: string,
    readonly size: bigint,
  ) {}

  plan(tables: readonly string[], blocks: Iterable<bigint>): PlannedPartition[] {
    const ns = new Set<bigint>();
    for (const b of blocks) ns.add(partitionOf(b, this.size));
    const out: PlannedPartition[] = [];
    for (const table of tables) {
      for (const n of ns) {
        const key = `${table}:${n}`;
        if (!this.made.has(key)) out.push({ key, sql: partitionDdl(this.schema, table, n, this.size) });
      }
    }
    return out;
  }

  remember(planned: readonly PlannedPartition[]): void {
    for (const p of planned) this.made.add(p.key);
  }
}

export interface Store {
  schema: string;
  tables: ReadonlyMap<string, TableSpec>; // event tables by name
  partitions: Partitions;
}

export function createStore(schema: string, defs: EventDef[], partitionBlocks: number): Store {
  const specs = defs.map((d) => buildEventTable(schema, d));
  return {
    schema,
    tables: new Map(specs.map((s) => [s.table, s])),
    partitions: new Partitions(schema, BigInt(partitionBlocks)),
  };
}

// The contract behind each table, recorded once instead of in every row.
export function contractMeta(defs: EventDef[]): Record<string, string> {
  return Object.fromEntries(defs.map((d) => [`contract:${d.tableName}`, d.address.toLowerCase()]));
}

// One statement per table, whatever the row count: each column travels as one
// array, so a database ~40 ms away costs one round trip per table instead of
// one per row.
export function unnestInsert(qualifiedTable: string, columns: readonly ColumnSpec[], conflict: string): string {
  const names = columns.map((c) => q(c.name)).join(', ');
  const arrays = columns.map((c, i) => `$${i + 1}::${c.pgType}[]`).join(', ');
  return `INSERT INTO ${qualifiedTable} (${names}) SELECT * FROM unnest(${arrays}) ON CONFLICT ${conflict} DO NOTHING`;
}

function columnArrays(columns: readonly ColumnSpec[], rows: ReadonlyArray<Record<string, unknown>>): unknown[][] {
  return columns.map((c) => rows.map((r) => r[c.name] ?? null));
}

export async function commitBatch(
  pool: pg.Pool,
  store: Store,
  rows: DecodedRow[],
  deadLetters: DeadLetterEntry[],
  newCursor: bigint,
): Promise<number> {
  const { schema } = store;
  const byTable = new Map<string, Array<Record<string, unknown>>>();
  const blocks = new Map<string, { hash: Buffer; time: unknown }>();
  for (const r of rows) {
    const group = byTable.get(r.tableName) ?? [];
    group.push(r.columns);
    byTable.set(r.tableName, group);
    blocks.set(String(r.columns['block_number']), {
      hash: Buffer.from(r.blockHash.slice(2), 'hex'),
      time: r.columns['block_time'],
    });
  }
  const planned = store.partitions.plan(
    byTable.size ? ['_blocks', ...byTable.keys()] : [],
    [...blocks.keys()].map(BigInt),
  );

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const p of planned) await client.query(p.sql);
    if (blocks.size) {
      await client.query(unnestInsert(`${q(schema)}._blocks`, BLOCK_COLUMNS, '(block_number)'), [
        [...blocks.keys()],
        [...blocks.values()].map((b) => b.hash),
        [...blocks.values()].map((b) => b.time),
      ]);
    }
    for (const [table, group] of byTable) {
      const spec = store.tables.get(table);
      if (!spec) throw new Error(`no table spec for ${table}`);
      const res = await client.query(
        unnestInsert(`${q(schema)}.${q(table)}`, spec.columns, '(block_number, log_index)'),
        columnArrays(spec.columns, group),
      );
      inserted += res.rowCount ?? 0;
    }
    if (deadLetters.length) {
      await client.query(
        `INSERT INTO ${q(schema)}._dead_letter (block_number, tx_hash, log_index, address, topics, data, error)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::integer[], $4::text[], $5::jsonb[], $6::text[], $7::text[])`,
        [
          deadLetters.map((d) => d.blockNumber?.toString() ?? null),
          deadLetters.map((d) => d.txHash),
          deadLetters.map((d) => d.logIndex),
          deadLetters.map((d) => d.address),
          deadLetters.map((d) => JSON.stringify(d.topics)),
          deadLetters.map((d) => d.data),
          deadLetters.map((d) => d.error),
        ],
      );
    }
    await client.query(
      `UPDATE ${q(schema)}._cursor SET last_block = $1, updated_at = now() WHERE id = 1`,
      [newCursor.toString()],
    );
    await client.query('COMMIT');
    store.partitions.remember(planned);
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Wire the pipeline, main and insights reads**

`packages/worker/src/pipeline.ts`:
- import `{ bootstrap, commitBatch, contractMeta, getCursor, initCursor, type DeadLetterEntry, type Store } from './db.js'`; drop `buildEventTable` from the core import.
- `PipelineDeps` gains `store: Store;` (after `schema`).
- `bootstrapIndexer`:

```ts
export async function bootstrapIndexer(deps: PipelineDeps): Promise<void> {
  await bootstrap(
    deps.pool, deps.schema, buildControlTables(deps.schema), [...deps.store.tables.values()], contractMeta(deps.defs),
  );
  await initCursor(deps.pool, deps.schema, initialCursor(deps.cfg));
}
```

- in `runOnce`: `const inserted = await commitBatch(pool, deps.store, rows, dead, safeTo);`

`packages/worker/src/main.ts`: import `createStore` from `./db.js`; in the `deps` literal add, after `schema`:

```ts
    store: createStore(schemaName(cfg.indexerName), defs, cfg.storage.partitionBlocks),
```

`packages/worker/src/insightsdb.ts` — `readEventRows` reads bytea back as the `0x` strings the insight loop keys transactions and parties by:

```ts
    const c = t.transferColumns;
    const hexOf = (col: string) => `'0x' || encode(${q(col)}, 'hex')`;
    const extra = c ? `, ${hexOf(c[0])} AS t_from, ${hexOf(c[1])} AS t_to, ${q(c[2])}::text AS t_value` : '';
    const r = await pool.query(
      `SELECT block_number, ${hexOf('tx_hash')} AS tx_hash, log_index${extra} FROM ${q(schema)}.${q(t.tableName)}
       WHERE block_number BETWEEN $1 AND $2`,
      [from.toString(), to.toString()],
    );
```

- [ ] **Step 5: Update the other worker tests' call sites**

- `pipeline.test.ts`: import `createStore` from `../src/db.js`; every `PipelineDeps` literal gets `store: createStore(<its schema>, <its defs>, 1_000_000)` (the main one: `createStore('idx_demo', defs, 1_000_000)` where `defs` is hoisted to a const used by both `defs:` and `store:`; repeat for each other literal such as the `idx_clamp` one, with its own schema).
- `insights.test.ts`: import `{ bootstrap, commitBatch, contractMeta, createStore, initCursor, type Store }`; build `const store: Store = createStore(SCHEMA, defs, 1_000_000)` in `beforeEach` (after the DROP), call `bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], contractMeta(defs))` (also in the `prepareInsights…` test) and `commitBatch(pool, store, …)` everywhere. Change the row helpers to layout 2:

```ts
const b = (h: string) => Buffer.from(h.slice(2), 'hex');
const common = (block: number, n: number) => ({
  block_number: String(block), block_time: new Date(0), tx_hash: b(tx(n)), tx_index: 0, log_index: n,
});
const transferRow = (block: number, n: number, value: bigint): DecodedRow => ({
  tableName: 'tok_transfer', blockHash: `0x${'bb'.repeat(32)}`,
  columns: { ...common(block, n), from: b(WALLET), to: b(WALLET2), value: value.toString() },
});
const depositRow = (block: number, n: number): DecodedRow => ({
  tableName: 'vault_deposited', blockHash: `0x${'bb'.repeat(32)}`,
  columns: { ...common(block, n), user: b(WALLET), amount: '5' },
});
```

- `deadletter.test.ts`: apply the same `createStore`/`bootstrap`/`commitBatch` signature changes (read the file; it uses the pipeline with a malformed log — only its setup calls change).

- [ ] **Step 6: Run the worker suite**

Run: `corepack pnpm -r build && corepack pnpm --filter @arckive/worker test`
Expected: PASS (all files; `_insights` is still layout 1 here and stores the hex strings `readEventRows` returns).

- [ ] **Step 7: Commit**

```bash
git add packages/worker
git commit -m "feat(worker)!: write storage layout 2 — layout check, partitions, one INSERT per table"
```

---

### Task 5: Block times from logs and an adaptive getLogs span

**Files:**
- Modify: `packages/worker/src/rpc.ts` (add `blockTimesFromLogs`, `isRangeCapError`)
- Create: `packages/worker/src/rangesizer.ts`
- Modify: `packages/worker/src/pipeline.ts` (use both; `PipelineDeps.sizer?`)
- Modify: `packages/worker/src/main.ts` (create the sizer)
- Test: `packages/worker/test/rpc.test.ts` (unit additions), create `packages/worker/test/rangesizer.test.ts`, `packages/worker/test/pipeline.test.ts` (capped client)

**Interfaces:**
- Consumes: Task 4's `PipelineDeps`.
- Produces:
  - `blockTimesFromLogs(logs: ReadonlyArray<{ blockNumber: bigint | null; blockTimestamp?: bigint | null }>): Map<bigint, Date> | null`
  - `isRangeCapError(err: unknown): boolean`
  - `class RangeSizer { constructor(max: number); readonly size: number; shrink(): boolean; succeeded(): boolean }`, `GROW_AFTER = 20`
  - `PipelineDeps.sizer?: RangeSizer`

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/test/rpc.test.ts` (outside the anvil-backed describe, as a new describe; import the two functions):

```ts
describe('blockTimesFromLogs', () => {
  it('reads every block time from the logs when all carry blockTimestamp', () => {
    const times = blockTimesFromLogs([
      { blockNumber: 5n, blockTimestamp: 1_700_000_000n },
      { blockNumber: 6n, blockTimestamp: 1_700_000_001n },
    ]);
    expect(times?.get(5n)?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(times?.size).toBe(2);
  });

  it('gives up for the whole batch if any log lacks it', () => {
    expect(blockTimesFromLogs([{ blockNumber: 5n, blockTimestamp: 1n }, { blockNumber: 6n }])).toBeNull();
    expect(blockTimesFromLogs([{ blockNumber: 5n, blockTimestamp: null }])).toBeNull();
  });

  it('an empty batch needs no times', () => {
    expect(blockTimesFromLogs([])?.size).toBe(0);
  });
});

describe('isRangeCapError', () => {
  it('recognises provider range and result caps', () => {
    expect(isRangeCapError(new Error('ranges over 10000 blocks are not supported on free plan'))).toBe(true);
    expect(isRangeCapError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeCapError(new Error('block range is too large'))).toBe(true);
    expect(isRangeCapError(new Error('Log response size exceeded.'))).toBe(true);
    expect(isRangeCapError(Object.assign(new Error('RPC Request failed.'), { details: 'exceed maximum block range: 2000' }))).toBe(true);
    expect(isRangeCapError(new Error('outer', { cause: new Error('ranges over 100 blocks') }))).toBe(true);
  });

  it('a rate limit is not a cap, however it is worded', () => {
    expect(isRangeCapError(new Error('Too many requests, try again later'))).toBe(false);
    expect(isRangeCapError(new Error('rate limit exceeded'))).toBe(false);
    expect(isRangeCapError(new Error('HTTP request failed. Status: 429'))).toBe(false);
    expect(isRangeCapError(new Error('fetch failed'))).toBe(false);
  });
});
```

Create `packages/worker/test/rangesizer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { GROW_AFTER, RangeSizer } from '../src/rangesizer.js';

describe('RangeSizer', () => {
  it('halves on a cap, never below 1', () => {
    const s = new RangeSizer(1000);
    expect(s.shrink()).toBe(true);
    expect(s.size).toBe(500);
    while (s.shrink()) { /* down to 1 */ }
    expect(s.size).toBe(1);
    expect(s.shrink()).toBe(false);
  });

  it(`doubles back after ${GROW_AFTER} clean ranges, up to the configured size`, () => {
    const s = new RangeSizer(100);
    s.shrink(); // 50
    for (let i = 0; i < GROW_AFTER - 1; i++) expect(s.succeeded()).toBe(false);
    expect(s.succeeded()).toBe(true);
    expect(s.size).toBe(100);
    for (let i = 0; i < 3 * GROW_AFTER; i++) s.succeeded();
    expect(s.size).toBe(100);
  });

  it('a cap resets the run of clean ranges', () => {
    const s = new RangeSizer(100);
    s.shrink(); // 50
    for (let i = 0; i < GROW_AFTER - 1; i++) s.succeeded();
    s.shrink(); // 25
    expect(s.succeeded()).toBe(false);
    expect(s.size).toBe(25);
  });
});
```

Add to `packages/worker/test/pipeline.test.ts` (import `RangeSizer` from `../src/rangesizer.js`, `createStore` from `../src/db.js`):

```ts
  it('a provider range cap shrinks the span without going Degraded, and every event still lands', async () => {
    const real = deps.client;
    const capped = {
      ...real,
      getLogs: (args: { fromBlock: bigint; toBlock: bigint }) =>
        args.toBlock - args.fromBlock + 1n > 2n
          ? Promise.reject(new Error('ranges over 10000 blocks are not supported on free plan'))
          : real.getLogs(args as never),
    } as unknown as PipelineDeps['client'];
    const schema = 'idx_capped';
    const sizer = new RangeSizer(1000);
    const d: PipelineDeps = {
      ...deps,
      client: capped,
      schema,
      store: createStore(schema, deps.defs, 1_000_000),
      cfg: { ...deps.cfg, polling: { ...deps.cfg.polling, batchBlocks: 1000 } },
      phase: new PhaseTracker(),
      sizer,
    };
    await bootstrapIndexer(d);
    let rounds = 0;
    while ((await runOnce(d)) && rounds++ < 200) {
      expect(d.phase.phase).not.toBe('Degraded');
    }
    const r = await pool.query(`SELECT count(*)::int AS c FROM ${schema}.emitter_ping`);
    expect(r.rows[0].c).toBeGreaterThanOrEqual(5);
    expect(sizer.size).toBeLessThanOrEqual(2);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `corepack pnpm --filter @arckive/worker test -- rpc rangesizer pipeline`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

Append to `packages/worker/src/rpc.ts`:

```ts
// Arc's eth_getLogs carries blockTimestamp on every log; when every log in an
// answer has it, no block has to be fetched for its time — a full-history
// backfill would otherwise spend one getBlock per block. Mixed answers fall
// back whole: a guessed time would be a wrong row.
export function blockTimesFromLogs(
  logs: ReadonlyArray<{ blockNumber: bigint | null; blockTimestamp?: bigint | null }>,
): Map<bigint, Date> | null {
  const times = new Map<bigint, Date>();
  for (const l of logs) {
    if (l.blockNumber == null || l.blockTimestamp == null) return null;
    times.set(l.blockNumber, new Date(Number(l.blockTimestamp) * 1000));
  }
  return times;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    if (e instanceof Error) parts.push(e.message);
    const details = (e as { details?: unknown }).details;
    if (typeof details === 'string') parts.push(details);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

const RATE_LIMIT = /rate.?limit|too many requests|status: 429|\b429\b/i;
const RANGE_CAP =
  /block range|ranges? over|range (is )?too (large|wide|big)|range limit|max(imum)? (block )?range|too many (blocks|logs|results)|more than \d+ (results|logs|blocks)|response size|query returned more than/i;

// Providers cap eth_getLogs by block span or by result size, each in words of
// its own (drpc's free plan: "ranges over 10000 blocks are not supported", at
// 101 blocks). A rate limit is not a cap: it keeps the backoff.
export function isRangeCapError(err: unknown): boolean {
  const text = errorText(err);
  return !RATE_LIMIT.test(text) && RANGE_CAP.test(text);
}
```

Create `packages/worker/src/rangesizer.ts`:

```ts
// The pipeline's working getLogs span. A provider cap halves it at once
// (floor 1); every GROW_AFTER clean ranges double it again, up to the
// configured batchBlocks, so a cap that was lifted is found again. Kept in
// memory only: after a restart the cap is found again in log2(batchBlocks)
// calls, which is cheaper than persisting a value that may be stale.
export const GROW_AFTER = 20;

export class RangeSizer {
  private current: number;
  private clean = 0;

  constructor(private readonly max: number) {
    this.current = max;
  }

  get size(): number {
    return this.current;
  }

  shrink(): boolean {
    if (this.current <= 1) return false;
    this.current = Math.max(1, Math.floor(this.current / 2));
    this.clean = 0;
    return true;
  }

  // true when the span grew
  succeeded(): boolean {
    if (this.current >= this.max) return false;
    if (++this.clean < GROW_AFTER) return false;
    this.current = Math.min(this.max, this.current * 2);
    this.clean = 0;
    return true;
  }
}
```

In `packages/worker/src/pipeline.ts`:
- import `blockTimesFromLogs, isRangeCapError` from `./rpc.js` and `type RangeSizer` from `./rangesizer.js`.
- `PipelineDeps` gains:

```ts
  // the working getLogs span; absent = always cfg.polling.batchBlocks
  sizer?: RangeSizer;
```

- in `runOnce`, the range: `const range = planRange(cursor, finalized, deps.sizer?.size ?? cfg.polling.batchBlocks);`
- wrap the fetch (both branches: the `Promise.all` hot path and the plain `fetchLogs`) in one `try`:

```ts
  let logs;
  let safeTo = range.toBlock;
  try {
    if (signalHead && finalized === signalHead.number) {
      // … unchanged hot-path body (Promise.all, queryHead guard, filter) …
    } else {
      logs = await fetchLogs(client, addresses, range.fromBlock, range.toBlock);
    }
  } catch (err) {
    // A provider cap is not an outage: retry at once with half the span
    // instead of going Degraded and backing off for 30 s.
    const before = deps.sizer?.size;
    if (deps.sizer && isRangeCapError(err) && deps.sizer.shrink()) {
      deps.log.warn({ from: before, to: deps.sizer.size }, 'getLogs range capped by the provider — shrinking the span');
      return true;
    }
    throw err;
  }
  const times =
    blockTimesFromLogs(logs) ??
    (await getBlockTimes(client, logs.map((l) => l.blockNumber!), deps.headSignal.blockTimes()));
```

(The `if (queryHead < range.fromBlock) return false;` inside the hot path stays as it is.)
- after the commit (next to `deps.onCommitted?.()`):

```ts
  if (deps.sizer?.succeeded()) deps.log.info({ size: deps.sizer.size }, 'getLogs span grown');
```

In `packages/worker/src/main.ts`: import `RangeSizer` from `./rangesizer.js`; in the `deps` literal add `sizer: new RangeSizer(cfg.polling.batchBlocks),`.

- [ ] **Step 4: Run the worker suite**

Run: `corepack pnpm -r build && corepack pnpm --filter @arckive/worker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker
git commit -m "feat(worker): block times from logs, adaptive getLogs span on provider caps"
```

---

### Task 6: Insights in layout 2 — `_sentences`, narrow `_insights`, native USDC

**Files:**
- Modify: `packages/core/src/ddl.ts` (`buildInsightsTables`)
- Modify: `packages/worker/src/insightsdb.ts` (`InsightRow`, `commitInsights`)
- Modify: `packages/worker/src/insights.ts` (`InsightsDeps.partitions`, `finishRound`, `prepareInsights`)
- Modify: `packages/worker/src/main.ts` (`knownToken` before `readTokenInfo`)
- Test: `packages/core/test/ddl.test.ts`, `packages/worker/test/insights.test.ts`

**Interfaces:**
- Consumes: Task 4 (`Partitions`, `unnestInsert`), Task 3 (`knownToken`), Task 1 (`cfg.storage.partitionBlocks`).
- Produces:
  - `buildInsightsTables(schema): string[]` creating `_sentences`, partitioned `_insights`, `_insights_lane_idx (lane, block_number)`, `_insights_cursor`, view `_insights_full`.
  - `InsightRow = { blockNumber: bigint; logIndex: number; lane: string; laneP: number | null; ruled: boolean; protocol: string; facts: string[]; probabilities: Record<string, number> | null; sentence: string; model: string | null }`
  - `commitInsights(pool, schema, partitions: Partitions, rows: InsightRow[], newCursor: bigint): Promise<string[]>` (lanes of inserted rows)
  - `InsightsDeps.partitions: Partitions`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/ddl.test.ts`:

```ts
describe('buildInsightsTables (layout 2)', () => {
  const s = buildInsightsTables('idx_x');
  it('keeps one row per event, keyed like the events, and sentences once', () => {
    const sentences = s.find((x) => x.includes('"idx_x"._sentences'))!;
    expect(sentences).toContain('UNIQUE (sentence, model)');
    const insights = s.find((x) => x.includes('"idx_x"."_insights" ('))!;
    expect(insights).toContain('PRIMARY KEY (block_number, log_index)');
    expect(insights).toContain('facts text[] NOT NULL');
    expect(insights).toContain('sentence_id integer NOT NULL');
    expect(insights).toMatch(/PARTITION BY RANGE \(block_number\)$/);
    expect(insights).not.toContain('tx_hash');
    expect(insights).not.toContain('table_name');
  });
  it('indexes lanes for "latest of a lane" and offers a joined view', () => {
    expect(s).toContain('CREATE INDEX IF NOT EXISTS "_insights_lane_idx" ON "idx_x"."_insights" (lane, block_number)');
    expect(s.some((x) => x.startsWith('CREATE OR REPLACE VIEW "idx_x"."_insights_full"'))).toBe(true);
  });
});
```

In `packages/worker/test/insights.test.ts`:
- `deps` gains `partitions: new Partitions(SCHEMA, 1_000_000n)` (import `Partitions` from `../src/db.js`).
- `insights()` reads the view: `SELECT * FROM ${SCHEMA}._insights_full ORDER BY block_number, log_index`.
- first test: replace `expect(rows.map((r) => r.tx_hash)).toEqual([tx(1), tx(2), tx(3)]);` with `expect(rows.map((r) => [r.block_number, r.log_index])).toEqual([['100', 1], ['101', 2], ['102', 3]]);`
- second test: replace `expect(deposit).toMatchObject({ protocol: 'vault', table_name: 'vault_deposited' });` with `expect(deposit).toMatchObject({ protocol: 'vault' });`. Keep every other assertion (the view returns `lane`, `lane_p`, `ruled`, `protocol`, `facts`, `model`, `probabilities`, `sentence`).
- add:

```ts
  it('stores each sentence once and a ruled row with no protocol as NULL', async () => {
    // tx(2) and tx(4) share the same plain context, so their ruled sentences are equal
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), transferRow(103, 4, 0n)], [], 103n);
    await runInsightsOnce(deps, 'laya-test');
    const sentences = await pool.query(`SELECT sentence, model FROM ${SCHEMA}._sentences ORDER BY id`);
    expect(new Set(sentences.rows.map((r) => `${r.model}|${r.sentence}`)).size).toBe(sentences.rows.length);
    const ruled = (await insights()).filter((r) => r.ruled);
    expect(ruled).toHaveLength(2);
    expect(ruled[0].sentence_id).toBe(ruled[1].sentence_id);
    for (const r of ruled) expect(r).toMatchObject({ model: null, probabilities: null });
    const raw = await pool.query(`SELECT protocol FROM ${SCHEMA}._insights WHERE ruled`);
    expect(raw.rows.some((r) => r.protocol === '')).toBe(false);
  });
```

- the `prepareInsights…` test: add `storage` is defaulted by `parseWorkerConfig`, so nothing to add; assert `prepared.partitions.size` is `2_000_000n`.

- [ ] **Step 2: Run to see them fail**

Run: `corepack pnpm -r build; corepack pnpm --filter @arckive/core test -- ddl; corepack pnpm --filter @arckive/worker test -- insights`
Expected: FAIL.

- [ ] **Step 3: Implement core DDL**

Replace `buildInsightsTables` in `packages/core/src/ddl.ts`:

```ts
// Insights live beside the event tables, never in them: event tables keep
// their hot-path shape, and "not classified yet" is simply "no row". Keyed
// like the event rows, so any event table joins on (block_number, log_index).
// The model's answer is a function of the sentence and the model, so it is
// stored once per (sentence, model) — model '' for ruled rows — and every row
// points at it.
export function buildInsightsTables(schema: string): string[] {
  const s = q(schema);
  return [
    `CREATE TABLE IF NOT EXISTS ${s}._sentences (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sentence text NOT NULL,
  model text NOT NULL DEFAULT '',
  probabilities jsonb,
  UNIQUE (sentence, model)
)`,
    `CREATE TABLE IF NOT EXISTS ${s}.${q('_insights')} (
  block_number bigint NOT NULL,
  log_index integer NOT NULL,
  lane text NOT NULL,
  lane_p real,
  ruled boolean NOT NULL,
  protocol text,
  facts text[] NOT NULL,
  sentence_id integer NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block_number, log_index)
) PARTITION BY RANGE (block_number)`,
    // serves "the latest rows of a lane"
    `CREATE INDEX IF NOT EXISTS ${q('_insights_lane_idx')} ON ${s}.${q('_insights')} (lane, block_number)`,
    `CREATE TABLE IF NOT EXISTS ${s}.${q('_insights_cursor')} (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    // for plain SQL: each row with its sentence and the answer behind its lane
    `CREATE OR REPLACE VIEW ${s}.${q('_insights_full')} AS
SELECT i.block_number, i.log_index, i.lane, i.lane_p, i.ruled, i.protocol, i.facts, i.sentence_id,
       s.sentence, NULLIF(s.model, '') AS model, s.probabilities, i.classified_at
FROM ${s}.${q('_insights')} i JOIN ${s}._sentences s ON s.id = i.sentence_id`,
  ];
}
```

- [ ] **Step 4: Implement the worker side**

`packages/worker/src/insightsdb.ts`:
- `InsightRow` drops `txHash` and `tableName` (see Interfaces).
- import `type Partitions` from `./db.js`.
- replace `commitInsights`:

```ts
// Sentence ids for a round: one insert of the new (sentence, model) pairs and
// one select of all of them. Sentences are few — Radar caches answers per
// exact sentence for the same reason — so this stays two small statements.
async function sentenceIds(client: pg.PoolClient, schema: string, rows: InsightRow[]): Promise<Map<string, number>> {
  const key = (sentence: string, model: string) => `${model}\u0000${sentence}`;
  const unique = new Map<string, { sentence: string; model: string; probabilities: string | null }>();
  for (const r of rows) {
    const model = r.model ?? '';
    unique.set(key(r.sentence, model), {
      sentence: r.sentence, model, probabilities: r.probabilities ? JSON.stringify(r.probabilities) : null,
    });
  }
  const all = [...unique.values()];
  await client.query(
    `INSERT INTO ${q(schema)}._sentences (sentence, model, probabilities)
     SELECT * FROM unnest($1::text[], $2::text[], $3::jsonb[]) ON CONFLICT (sentence, model) DO NOTHING`,
    [all.map((x) => x.sentence), all.map((x) => x.model), all.map((x) => x.probabilities)],
  );
  const r = await client.query(
    `SELECT s.id, s.sentence, s.model FROM ${q(schema)}._sentences s
     JOIN unnest($1::text[], $2::text[]) AS u(sentence, model) USING (sentence, model)`,
    [all.map((x) => x.sentence), all.map((x) => x.model)],
  );
  return new Map(r.rows.map((x) => [key(x.sentence, x.model), Number(x.id)]));
}

// Rows and cursor in one transaction, like commitBatch: a round is either all
// written or not at all. Returns the lanes of the rows actually inserted.
export async function commitInsights(
  pool: pg.Pool, schema: string, partitions: Partitions, rows: InsightRow[], newCursor: bigint,
): Promise<string[]> {
  const planned = partitions.plan(rows.length ? ['_insights'] : [], rows.map((r) => r.blockNumber));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of planned) await client.query(p.sql);
    let inserted: string[] = [];
    if (rows.length) {
      const ids = await sentenceIds(client, schema, rows);
      // facts cannot travel through unnest as an array of arrays (unnest
      // flattens them): each row's facts go as one comma-joined string, split
      // here. Fact names are identifiers and never contain commas.
      const res = await client.query(
        `INSERT INTO ${q(schema)}._insights
           (block_number, log_index, lane, lane_p, ruled, protocol, facts, sentence_id)
         SELECT b, l, lane, p, ruled, protocol,
                CASE WHEN f = '' THEN '{}'::text[] ELSE string_to_array(f, ',') END, sid
         FROM unnest($1::bigint[], $2::integer[], $3::text[], $4::real[], $5::boolean[], $6::text[], $7::text[], $8::integer[])
              AS u(b, l, lane, p, ruled, protocol, f, sid)
         ON CONFLICT (block_number, log_index) DO NOTHING
         RETURNING lane`,
        [
          rows.map((r) => r.blockNumber.toString()),
          rows.map((r) => r.logIndex),
          rows.map((r) => r.lane),
          rows.map((r) => r.laneP),
          rows.map((r) => r.ruled),
          rows.map((r) => r.protocol || null),
          rows.map((r) => r.facts.join(',')),
          rows.map((r) => ids.get(`${r.model ?? ''}\u0000${r.sentence}`)!),
        ],
      );
      inserted = res.rows.map((x) => x.lane as string);
    }
    await client.query(
      `UPDATE ${q(schema)}._insights_cursor SET last_block = $1, updated_at = now() WHERE id = 1`,
      [newCursor.toString()],
    );
    await client.query('COMMIT');
    partitions.remember(planned);
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

`packages/worker/src/insights.ts`:
- import `{ Partitions }` from `./db.js` (value import, used in `prepareInsights`).
- `InsightsDeps` gains `partitions: Partitions;` with the comment `// _insights partitions this process has created (db.ts)`.
- in `finishRound`, build rows without `txHash`/`tableName`:

```ts
    return {
      blockNumber: row.blockNumber, logIndex: row.logIndex,
      lane, laneP, ruled: Boolean(d.ruled), protocol: d.protocol, facts: d.facts,
      probabilities: answer?.probabilities ?? null, sentence: d.sentence, model: answer ? model : null,
    };
```

and call `commitInsights(pool, schema, deps.partitions, insights, toBlock)`.
- `prepareInsights` return object gains `partitions: new Partitions(input.schema, BigInt(cfg.storage.partitionBlocks)),`.

`packages/worker/src/main.ts`: import `knownToken` from `@arckive/core`; change the `readToken` line to

```ts
        // native USDC has no symbol()/decimals() to read (core insights/tokens.ts)
        readToken: async (address, fallback) =>
          knownToken(cfg.network.chainId, address) ?? readTokenInfo(client, address, fallback),
```

- [ ] **Step 5: Run everything**

Run: `corepack pnpm -r build && corepack pnpm -r test`
Expected: PASS (core, operator, worker).

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/worker
git commit -m "feat!: insights in layout 2 — sentences once, narrow partitioned _insights, native USDC token"
```

---

### Task 7: Docs, mainnet example manifest, full verification

**Files:**
- Modify: `README.md` (new "Storage layout" section after "Insights (optional)"; quickstart query examples if they use text addresses)
- Modify: `CLAUDE.md` ("Database schema and naming" and "Ingest loop" bullets)
- Create: `manifests/arc-mainnet/k8s/explorer.yaml`
- Verify: `e2e/kind.test.ts` (only `count(*)` queries — expected unchanged), `packages/worker/scripts/bench/*` (read `_ingested_at`/`block_time` only — expected unchanged)

**Interfaces:** none (docs and config).

- [ ] **Step 1: README section**

Add after the Insights section:

````markdown
## Storage layout

Arckive writes **storage layout 2** (recorded in `_meta` as `layout = 2`):

- Hashes and addresses are `bytea`. psql prints them as `\x…`; filter with a
  `'\x…'` literal so the index is used:

  ```sql
  SELECT block_time, "from", "to", value
  FROM idx_usdc.usdc_transfer
  WHERE "to" = '\x8366a39cc670b4001a1121b8f6a443a643e40951'
  ORDER BY block_number DESC LIMIT 20;
  ```

  Every event table has a `<table>_hex` view with `0x…` text for dashboards
  and exports; filter on the base table, not on the view.
- Rows are keyed by `(block_number, log_index)`. The block hash is stored once
  per block in `_blocks`; the contract address once per table in `_meta`
  (`contract:<table>`).
- Every row table is range-partitioned by `block_number`,
  `spec.storage.partitionBlocks` blocks per partition (default 2,000,000).
- Insights keep one narrow row per event in `_insights` and each sentence
  once in `_sentences`; `_insights_full` joins them.

Upgrading from layout 1: a worker refuses a schema written by layout 1
(`LayoutError` in its log). Drop the schema (`DROP SCHEMA idx_<name> CASCADE`)
or rename the Indexer, and it re-indexes from `startBlock`. Apply the CRD
change by hand: `kubectl apply -f charts/arckive/crds/indexer.yaml`.
````

- [ ] **Step 2: CLAUDE.md**

In "Database schema and naming", replace the bullet about `COMMON_COLUMNS`/`UNIQUE (block_number, tx_hash, log_index)` and the control-tables bullet with:

```markdown
- Storage layout 2 (`STORAGE_LAYOUT`, `_meta.layout = '2'`): every event table
  gets `COMMON_COLUMNS` (`block_number`, `block_time`, `tx_hash` bytea,
  `tx_index`, `log_index`) plus `_ingested_at` (DB default `now()`, used for
  freshness measurement) and `PRIMARY KEY (block_number, log_index)`; inserts
  are `ON CONFLICT DO NOTHING`, making re-processing idempotent. Addresses and
  hashes are bytea; `<table>_hex` views print them as `0x…`.
- Every row table (event tables, `_blocks`, `_insights`) is
  `PARTITION BY RANGE (block_number)` in `storage.partitionBlocks` spans;
  partitions are created by the worker inside the commit that first needs them
  (`Partitions` in `worker/src/db.ts`, remembered only after COMMIT).
- Control tables per schema: `_cursor` (single row), `_meta` (layout +
  `contract:<table>`), `_dead_letter`, `_blocks` (hash/time once per block).
  A layout-1 schema is refused with `LayoutError`; there is no in-place migration.
```

In "Ingest loop", add after the first paragraph:

```markdown
`commitBatch` sends one `unnest` INSERT per table (plus `_blocks` and the
cursor), whatever the row count — a remote database pays one round trip per
table, not per row. Block times come from the logs' `blockTimestamp` when every
log has one (Arc does), else from `getBlockTimes`. A getLogs error that reads
as a provider range/result cap (`isRangeCapError`) halves the working span
(`RangeSizer`) and retries at once instead of going `Degraded`.
```

Also add `LayoutError` to the named-errors list in Conventions.

- [ ] **Step 3: Mainnet example manifest**

Create `manifests/arc-mainnet/k8s/explorer.yaml`:

```yaml
# Arc mainnet explorer data plane: every USDC movement and the Uniswap v4
# PoolManager, whole history (startBlock 0 backfills from genesis).
#
# Every USDC movement is logged once by 0xff…fe — a plain value send, value
# passed into a call, and the twin of every ERC-20 transfer through 0x3600…0000
# (same parties, 18 decimals) — so indexing that one log covers USDC without
# double counting. Needs a Secret pg-dsn (see ../../arc-testnet/k8s/pg-dsn-secret.example.yaml).
apiVersion: arckive.org/v1alpha1
kind: Indexer
metadata:
  name: arc-explorer
spec:
  network:
    chainId: 5042
    # the public endpoint serves full history and 2,000-block getLogs ranges
    rpc: ["https://rpc.mainnet.arc.io"]
    finalityTag: latest
  storage:
    mode: External
    external:
      dsnSecretRef: { name: pg-dsn, key: url }
  polling:
    batchBlocks: 2000
    intervalMs: 1000
  contracts:
    - name: usdc
      address: "0xfffffffffffffffffffffffffffffffffffffffe"
      startBlock: 0
      events: [Transfer]
      abi:
        inline:
          - type: event
            name: Transfer
            inputs:
              - { name: from, type: address, indexed: true }
              - { name: to, type: address, indexed: true }
              - { name: value, type: uint256, indexed: false }
    - name: poolmanager
      address: "0x8366a39cc670b4001a1121b8f6a443a643e40951"
      startBlock: 0
      events: [Initialize, ModifyLiquidity, Swap, Donate]
      abi:
        inline:
          - type: event
            name: Initialize
            inputs:
              - { name: id, type: bytes32, indexed: true }
              - { name: currency0, type: address, indexed: true }
              - { name: currency1, type: address, indexed: true }
              - { name: fee, type: uint24, indexed: false }
              - { name: tickSpacing, type: int24, indexed: false }
              - { name: hooks, type: address, indexed: false }
              - { name: sqrtPriceX96, type: uint160, indexed: false }
              - { name: tick, type: int24, indexed: false }
          - type: event
            name: ModifyLiquidity
            inputs:
              - { name: id, type: bytes32, indexed: true }
              - { name: sender, type: address, indexed: true }
              - { name: tickLower, type: int24, indexed: false }
              - { name: tickUpper, type: int24, indexed: false }
              - { name: liquidityDelta, type: int256, indexed: false }
              - { name: salt, type: bytes32, indexed: false }
          - type: event
            name: Swap
            inputs:
              - { name: id, type: bytes32, indexed: true }
              - { name: sender, type: address, indexed: true }
              - { name: amount0, type: int128, indexed: false }
              - { name: amount1, type: int128, indexed: false }
              - { name: sqrtPriceX96, type: uint160, indexed: false }
              - { name: liquidity, type: uint128, indexed: false }
              - { name: tick, type: int24, indexed: false }
              - { name: fee, type: uint24, indexed: false }
          - type: event
            name: Donate
            inputs:
              - { name: id, type: bytes32, indexed: true }
              - { name: sender, type: address, indexed: true }
              - { name: amount0, type: uint256, indexed: false }
              - { name: amount1, type: uint256, indexed: false }
```

- [ ] **Step 4: Full verification**

Run: `corepack pnpm lint && corepack pnpm -r build && corepack pnpm -r test`
Expected: lint clean, every suite PASS.
Run: `helm lint charts/arckive && scripts/build-install.sh && git diff --exit-code install.yaml`
Expected: no diff (install.yaml already regenerated in Task 1).
Run: `grep -n "tx_hash\|contract_address\|block_hash" e2e/kind.test.ts packages/worker/scripts -r`
Expected: no queries depending on the removed text columns (fix any that exist).

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md manifests/arc-mainnet
git commit -m "docs: storage layout 2, mainnet explorer manifest"
```

---

### Task 8: Real test on k3d against Arc mainnet (controller runs this)

**Files:** none committed except, if useful, measured numbers appended to the spec's "Measured" section.

- [ ] **Step 1: Build and load images**

```bash
docker build --target operator -t arckive-operator:v2 . && docker build --target worker -t arckive-worker:v2 .
k3d image import arckive-operator:v2 arckive-worker:v2 -c arckive
kubectl apply -f charts/arckive/crds/indexer.yaml
kubectl -n arckive-system set image deploy/arckive-operator operator=arckive-operator:v2
kubectl -n arckive-system set env deploy/arckive-operator WORKER_IMAGE=arckive-worker:v2
kubectl -n arckive-system patch deploy arckive-operator --type json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
```

(Container name and env layout per `install.yaml`; check with `kubectl -n arckive-system get deploy arckive-operator -o yaml`.)

- [ ] **Step 2: Layout-1 refusal on the existing testnet indexers**

The testnet `usdc-arc`/`flowswap` workers roll out on the new image (config hash changes). Expected: they exit with `LayoutError` in the log. Then `DROP SCHEMA idx_usdc_arc CASCADE; DROP SCHEMA idx_flowswap CASCADE;` and confirm they re-index and go Live on layout 2.

- [ ] **Step 3: Mainnet explorer indexer on a historical window**

Apply `manifests/arc-mainnet/k8s/explorer.yaml` with `startBlock` set to `head − 200000` for both contracts (≈ 28 h of history) and insights pointed at the Mac's Laya if reachable from the cluster. Watch: backfill blocks/s, `getLogs span` warnings, phase Live, `/metrics`.

- [ ] **Step 4: Measure and check**

```sql
-- bytes per event, including indexes, and per lane row
SELECT relname, pg_total_relation_size(oid) / greatest(reltuples, 1) FROM pg_class WHERE relname LIKE '%_p%' AND relkind = 'r';
-- no duplicate log keys, by construction (PK) — and compare row count to a direct getLogs count for one window
-- twins: every ERC-20 USDC log in a sample window has a native twin (RPC script)
```

Record: bytes/event (event + lane), backfill blocks/s, live lag p50, statements per commit (from pg_stat_statements or the worker log), sentence count vs row count.
