# Arckive storage layout 2 — dense rows (revision) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a USDC event with its lane from ~445 to ~310 bytes in pure PostgreSQL: rows keep only per-log data, addresses and lane labels are stored once, `tx_hash` uses a btree, and finished partitions get their indexes rebuilt once.

**Architecture:** Same split as the first layout-2 plan. `@arckive/core` owns DDL (event tables, `_blocks`, `_addresses`, `_labels`, views) and row encoding; `@arckive/worker` owns address/label resolution inside the commit transaction and the background index compaction. Layout version stays `'2'` (PR #26 is unmerged).

**Tech Stack:** TypeScript ESM, zod, viem 2.54, node-postgres, vitest, testcontainers (postgres:17-alpine), anvil, k3d.

**Spec:** `docs/superpowers/specs/2026-10-07-arckive-storage-v2-design.md` (§2, §3, §4, §5, §8, §11 revised; read them first)

## Global Constraints

- Relative imports carry `.js`; type-only imports use `import type`; env vars use bracket notation.
- All identifiers double-quoted; all values parameterized.
- English only; comments explain *why*; keep existing why-comments.
- Named error classes for domain failures.
- `STORAGE_LAYOUT` stays `'2'`. PRIMARY KEY `(block_number, log_index)` on event tables and `_insights`; inserts `ON CONFLICT (block_number, log_index) DO NOTHING`.
- Event table columns, in order: `block_number bigint`, `tx_hash bytea`, `log_index integer`, then parameters; an `address` parameter `p` is stored as `"<p>_id" integer` (snake_case name + `_id`). No `block_time`, `tx_index`, `_ingested_at`, `block_hash`, `contract_address` in event rows.
- `_blocks (block_number bigint, block_hash bytea NOT NULL, block_time timestamptz NOT NULL, _ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (block_number)) PARTITION BY RANGE (block_number)`.
- `_addresses (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, address bytea NOT NULL UNIQUE)`, not partitioned.
- `_labels (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, lane text NOT NULL, lane_p real, ruled boolean NOT NULL, protocol text, facts text[] NOT NULL, sentence_id integer NOT NULL, UNIQUE NULLS NOT DISTINCT (lane, lane_p, ruled, protocol, facts, sentence_id))` — needs PostgreSQL ≥ 15.
- `_insights (block_number bigint, log_index integer, lane text NOT NULL, label_id integer NOT NULL, PRIMARY KEY (block_number, log_index)) PARTITION BY RANGE (block_number)`; index `_insights_lane_idx (lane, block_number)`.
- `tx_hash` index is a btree named `<table>_tx_hash_idx`.
- Use `corepack pnpm …` (pnpm is not on PATH). Build before tests: `corepack pnpm -r build`.
- Commit trailer, exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg
  ```
- Between Task 1 and Task 2 worker tests are expected to fail (core changed first); every task's own package suite must pass.

## Review Focus

1. **A batch whose rows share an address across tables** (Transfer `to` = Swap `sender`) — one `_addresses` row, both tables get the same id (Task 2 test).
2. **A rolled-back commit that inserted new addresses** — no id leaks into later rows that points at a missing address; the next commit re-inserts it (Task 2 test).
3. **An address parameter that is NULL / zero address** — zero address is a normal address row; a NULL never reaches the writer from decode, but the writer must keep NULL as NULL (Task 2 unit test with a null column).
4. **Labels whose `lane_p` or `protocol` is NULL** — dedupe as equal (NULLS NOT DISTINCT) and resolve to one id (Task 3 test).
5. **A restart in the middle of a partition** — no compaction of the partition finished before the restart; the next rollover compacts exactly one partition (Task 4 test).

---

### Task 1: Core — dense event rows, `_blocks` time, `_addresses`, readable views

**Files:**
- Modify: `packages/core/src/ddl.ts`, `packages/core/src/decode.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/ddl.test.ts`, `packages/core/test/decode.test.ts`

**Interfaces:**
- Produces:
  - `interface ColumnSpec { name: string; pgType: string; address?: true }`
  - `interface EventColumn { name: string; abiType: string; indexed: boolean; viewName: string }` — for an `address` parameter `name` is `<snake>_id` and `viewName` is `<snake>` (after any `param_` prefixing); otherwise both are equal.
  - `COMMON_COLUMNS` = `[block_number bigint, tx_hash bytea, log_index integer]`
  - `BLOCK_COLUMNS` = `[block_number bigint, block_hash bytea, block_time timestamptz]` (the insert columns; `_ingested_at` is the DB default)
  - `pgTypeFor('address')` → `'integer'` (the stored id)
  - `buildEventTable(schema, def): TableSpec` — address columns carry `address: true`; statements: CREATE (partitioned), `tx_hash` btree index, btree per indexed param (on the `_id` column for addresses), `<table>_hex` view.
  - `buildControlTables(schema)` adds `_addresses` and the new `_blocks`.
  - `DecodedRow { tableName; blockHash: \`0x${string}\`; blockTime: Date; columns }` — columns: `block_number` (decimal string), `tx_hash` (Buffer), `log_index`, params; an address param is a 20-byte `Buffer` under its `_id` column name (the worker swaps it for an id).

- [ ] **Step 1: Write the failing tests** (replace the layout-2 describes in `ddl.test.ts`; keep `eventColumns` collision tests, update their expectations to the `_id` names):

```ts
describe('buildEventTable (dense layout 2)', () => {
  const transfer = extractEventDefs('usdc', ADDR, TRANSFER_ABI)[0]!;
  const spec = buildEventTable('idx_x', transfer);

  it('keeps only per-log columns and stores addresses as ids', () => {
    expect(spec.columns).toEqual([
      { name: 'block_number', pgType: 'bigint' },
      { name: 'tx_hash', pgType: 'bytea' },
      { name: 'log_index', pgType: 'integer' },
      { name: 'from_id', pgType: 'integer', address: true },
      { name: 'to_id', pgType: 'integer', address: true },
      { name: 'value', pgType: 'numeric(78,0)' },
    ]);
    const create = spec.statements[0]!;
    for (const gone of ['block_time', 'tx_index', '_ingested_at', 'block_hash', 'contract_address']) {
      expect(create).not.toContain(gone);
    }
    expect(create).toContain('"from_id" integer');
    expect(create).toContain('PRIMARY KEY (block_number, log_index)');
  });

  it('indexes tx_hash with a btree and indexed addresses by id', () => {
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_tx_hash_idx" ON "idx_x"."usdc_transfer" (tx_hash)',
    );
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_from_id_idx" ON "idx_x"."usdc_transfer" ("from_id")',
    );
  });

  it('the _hex view reads like the old rows: block time, ingest time and 0x addresses', () => {
    const view = spec.statements.find((s) => s.startsWith('CREATE OR REPLACE VIEW'))!;
    expect(view).toBe(
      'CREATE OR REPLACE VIEW "idx_x"."usdc_transfer_hex" AS SELECT t."block_number", b."block_time", ' +
        `'0x' || encode(t."tx_hash", 'hex') AS "tx_hash", t."log_index", b."_ingested_at", ` +
        `'0x' || encode(a0."address", 'hex') AS "from", '0x' || encode(a1."address", 'hex') AS "to", t."value" ` +
        'FROM "idx_x"."usdc_transfer" t JOIN "idx_x"."_blocks" b ON b."block_number" = t."block_number" ' +
        'LEFT JOIN "idx_x"."_addresses" a0 ON a0."id" = t."from_id" ' +
        'LEFT JOIN "idx_x"."_addresses" a1 ON a1."id" = t."to_id"',
    );
  });
});

describe('buildControlTables (dense layout 2)', () => {
  const s = buildControlTables('idx_x');
  it('_blocks carries block time and ingest time; _addresses stores each address once', () => {
    const blocks = s.find((x) => x.includes('"idx_x"._blocks'))!;
    expect(blocks).toContain('block_time timestamptz NOT NULL');
    expect(blocks).toContain('_ingested_at timestamptz NOT NULL DEFAULT now()');
    expect(blocks).toMatch(/PARTITION BY RANGE \(block_number\)$/);
    const addresses = s.find((x) => x.includes('"idx_x"._addresses'))!;
    expect(addresses).toContain('id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(addresses).toContain('address bytea NOT NULL UNIQUE');
    expect(addresses).not.toContain('PARTITION');
  });
});
```

`decode.test.ts` — replace the `decodeLogToRow` key-order test:

```ts
  it('fills dense columns; block hash and time ride beside them; addresses stay Buffers under _id', () => {
    const def = extractEventDefs('usdc', ADDR, TRANSFER_ABI)[0]!;
    const log = makeLog();
    const row = decodeLogToRow(def, log, new Date(1000));
    expect(row.blockHash).toBe(log.blockHash);
    expect(row.blockTime).toEqual(new Date(1000));
    expect(Object.keys(row.columns)).toEqual(['block_number', 'tx_hash', 'log_index', 'from_id', 'to_id', 'value']);
    expect(row.columns['from_id']).toEqual(Buffer.from(FROM.slice(2), 'hex'));
  });
```

- [ ] **Step 2: Run** `corepack pnpm --filter @arckive/core build; corepack pnpm --filter @arckive/core test -- ddl decode` — expect FAIL.

- [ ] **Step 3: Implement** (`ddl.ts`):

```ts
export interface ColumnSpec {
  name: string;
  pgType: string;
  // an address parameter: rows carry the 20-byte address, the table its _addresses id
  address?: true;
}

export const COMMON_COLUMNS: ReadonlyArray<ColumnSpec> = [
  { name: 'block_number', pgType: 'bigint' },
  { name: 'tx_hash', pgType: 'bytea' },
  { name: 'log_index', pgType: 'integer' },
];

// The insert columns of _blocks; _ingested_at is its DB default. Block time and
// ingest time are the same for every row of a block, so they live here once.
export const BLOCK_COLUMNS: ReadonlyArray<ColumnSpec> = [
  { name: 'block_number', pgType: 'bigint' },
  { name: 'block_hash', pgType: 'bytea' },
  { name: 'block_time', pgType: 'timestamptz' },
];
```

- `RESERVED` = common names + `block_time`, `tx_index`, `_ingested_at` (they still name columns readers see in the `_hex` view).
- `pgTypeFor('address')` returns `'integer'` with the comment `// the address's id in _addresses: 4 bytes, and each address is stored once`.
- `eventColumns`: after the `param_` rule, an `address` parameter gets `name = \`${base}_id\``, `viewName = base`; others `viewName = name`. The duplicate check runs on `name` (so `from` + `fromId` collide → `DdlError`).
- `buildEventTable`: `columns` = `COMMON_COLUMNS` + params mapped to `{ name, pgType: pgTypeFor(abiType), ...(abiType === 'address' ? { address: true } : {}) }`. CREATE lines: common columns `NOT NULL`, params nullable, `PRIMARY KEY (block_number, log_index)`, `PARTITION BY RANGE (block_number)`. Index statements: `... ON ${t} (tx_hash)` (btree, comment: measured 29.1 B/row vs 31.8 fresh / 36.2 live for hash on 170,045 mainnet rows — the btree deduplicates a transaction's ~2.6 rows), indexed params `CREATE INDEX IF NOT EXISTS "<table>_<name>_idx" ON ${t} ("<name>")`.
- `hexView(schema, table, columns, params)` produces exactly the SQL in the test: select list `t."block_number", b."block_time", '0x' || encode(t."tx_hash", 'hex') AS "tx_hash", t."log_index", b."_ingested_at"`, then each param in order — address `i`-th → `'0x' || encode(a<i>."address", 'hex') AS "<viewName>"` with `LEFT JOIN "<schema>"."_addresses" a<i> ON a<i>."id" = t."<name>"`; other bytea → `'0x' || encode(t."<name>", 'hex') AS "<name>"`; else `t."<name>"`. `FROM "<schema>"."<table>" t JOIN "<schema>"."_blocks" b ON b."block_number" = t."block_number"`. Keep the why-comment (filters belong on the base table; readers join through ids).
- `buildControlTables`: `_blocks` with the four columns (`_ingested_at timestamptz NOT NULL DEFAULT now()`), `PRIMARY KEY (block_number)`, partitioned; add `_addresses` (not partitioned; comment: grows with distinct addresses, not rows — 14,819 for 170,045 mainnet transfers).

`decode.ts`: `DecodedRow` gains `blockTime: Date`; `decodeLogToRow` columns are `block_number`, `tx_hash`, `log_index` and params under `col.name` (address params keep `toSqlValue`'s Buffer); return `{ tableName, blockHash: log.blockHash, blockTime, columns }`.

- [ ] **Step 4: Run** `corepack pnpm --filter @arckive/core build && corepack pnpm --filter @arckive/core test && corepack pnpm lint` — core PASS (worker red until Task 2).
- [ ] **Step 5: Commit** `feat(core)!: dense layout-2 rows — per-log columns only, address ids, readable views`.

---

### Task 2: Worker — resolve addresses and write block time in the commit; readers join

**Files:**
- Modify: `packages/worker/src/db.ts` (`commitBatch`), `packages/worker/src/insightsdb.ts` (`readEventRows`), `packages/worker/scripts/bench/freshness.ts`, `packages/worker/scripts/bench/backfill.ts`, `packages/worker/scripts/bench/report.ts` (text: freshness is per block from `_blocks`)
- Test: `packages/worker/test/db.test.ts`, and fixture updates in `insights.test.ts`, `pipeline.test.ts`, `deadletter.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ColumnSpec.address`, dense `COMMON_COLUMNS`/`BLOCK_COLUMNS`, `DecodedRow.blockTime`, `_addresses`).
- Produces: `commitBatch` unchanged signature; per commit to one table with address columns: BEGIN, address INSERT, address SELECT, `_blocks` INSERT, table INSERT, cursor UPDATE, COMMIT (7 statements); without address columns, no address statements.

- [ ] **Step 1: Failing tests** in `db.test.ts` (row helper now: `{ tableName: 'usdc_transfer', blockHash, blockTime: new Date('2026-07-03T00:00:00Z'), columns: { block_number, tx_hash, log_index, from_id: hex(FROM), to_id: hex(TO), value } }`):

```ts
  it('stores each address once and points rows at it', async () => {
    await commitBatch(pool, store, [row(10, 0), row(10, 1)], [], 10n);
    const a = await pool.query(`SELECT id, address FROM ${SCHEMA}._addresses ORDER BY id`);
    expect(a.rows.map((r) => r.address)).toEqual([hex('0x' + '1'.repeat(40)), hex('0x' + '2'.repeat(40))]);
    const t = await pool.query(`SELECT from_id, to_id FROM ${SCHEMA}.usdc_transfer ORDER BY log_index`);
    expect(t.rows).toEqual([{ from_id: a.rows[0].id, to_id: a.rows[1].id }, { from_id: a.rows[0].id, to_id: a.rows[1].id }]);
  });

  it('keeps an address id across commits', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    await commitBatch(pool, store, [row(11, 0)], [], 11n);
    const n = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}._addresses`);
    expect(n.rows[0].n).toBe(2);
  });

  it('a rolled-back commit leaves no address behind and the next commit re-inserts it', async () => {
    const bad = row(5000, 0);
    bad.columns['value'] = 'not a number';
    bad.columns['to_id'] = hex('0x' + '3'.repeat(40));
    await expect(commitBatch(pool, store, [bad], [], 5000n)).rejects.toThrow();
    const ok = row(5000, 0);
    ok.columns['to_id'] = hex('0x' + '3'.repeat(40));
    expect(await commitBatch(pool, store, [ok], [], 5000n)).toBe(1);
    const r = await pool.query(`SELECT "to" FROM ${SCHEMA}.usdc_transfer_hex WHERE block_number = 5000`);
    expect(r.rows[0].to).toBe('0x' + '3'.repeat(40));
  });

  it('keeps a NULL address column NULL', async () => {
    const r = row(12, 0);
    r.columns['to_id'] = null;
    await commitBatch(pool, store, [r], [], 12n);
    const t = await pool.query(`SELECT to_id FROM ${SCHEMA}.usdc_transfer WHERE block_number = 12`);
    expect(t.rows[0].to_id).toBeNull();
  });

  it('writes block time once per block and the readable view joins it', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    const b = await pool.query(`SELECT block_time, _ingested_at FROM ${SCHEMA}._blocks`);
    expect(b.rows[0].block_time).toEqual(new Date('2026-07-03T00:00:00Z'));
    expect(b.rows[0]._ingested_at).toBeInstanceOf(Date);
    const v = await pool.query(`SELECT block_time, "from", tx_hash FROM ${SCHEMA}.usdc_transfer_hex`);
    expect(v.rows[0]).toEqual({ block_time: new Date('2026-07-03T00:00:00Z'), from: '0x' + '1'.repeat(40), tx_hash: '0x' + 'b'.repeat(64) });
  });
```

Update the statement-count test's expectation to `7` (BEGIN, address INSERT, address SELECT, `_blocks`, table, cursor, COMMIT) for both 2 and 200 rows. Replace the old `_hex` test by the view test above.

- [ ] **Step 2: Run** `corepack pnpm -r build; corepack pnpm --filter @arckive/worker test -- db.test` — FAIL.

- [ ] **Step 3: Implement** in `db.ts` `commitBatch`, inside the transaction after partition DDL and before `_blocks`:

```ts
// Each address once: the batch's distinct addresses are inserted if new and
// read back as ids in the same transaction, so a rolled-back batch leaves no
// id pointing at an address that does not exist.
async function resolveAddresses(
  client: pg.PoolClient, schema: string, store: Store, byTable: ReadonlyMap<string, Array<Record<string, unknown>>>,
): Promise<void> {
  const wanted = new Map<string, Buffer>();
  for (const [table, group] of byTable) {
    for (const c of store.tables.get(table)!.columns) {
      if (!c.address) continue;
      for (const r of group) {
        const v = r[c.name];
        if (Buffer.isBuffer(v)) wanted.set(v.toString('hex'), v);
      }
    }
  }
  if (!wanted.size) return;
  const all = [...wanted.values()];
  await client.query(
    `INSERT INTO ${q(schema)}._addresses (address) SELECT unnest($1::bytea[]) ON CONFLICT (address) DO NOTHING`,
    [all],
  );
  const ids = new Map<string, number>();
  const res = await client.query(`SELECT id, address FROM ${q(schema)}._addresses WHERE address = ANY($1::bytea[])`, [all]);
  for (const x of res.rows) ids.set((x.address as Buffer).toString('hex'), Number(x.id));
  for (const [table, group] of byTable) {
    for (const c of store.tables.get(table)!.columns) {
      if (!c.address) continue;
      for (const r of group) {
        const v = r[c.name];
        if (Buffer.isBuffer(v)) r[c.name] = ids.get(v.toString('hex'))!;
      }
    }
  }
}
```

Group rows by table as shallow copies (`{ ...r.columns }`) so the caller's `DecodedRow` objects are not mutated (a retried batch must still carry Buffers). `_blocks` rows come from `r.blockHash` and `r.blockTime`. An unknown table still throws inside the transaction.

`insightsdb.ts` `readEventRows`: transfer columns are now `from_id`/`to_id`; read them as hex through `_addresses`:

```ts
    const c = t.transferColumns;
    const hexOf = (expr: string) => `'0x' || encode(${expr}, 'hex')`;
    const joins = c
      ? ` LEFT JOIN ${q(schema)}._addresses af ON af.id = e.${q(c[0])} LEFT JOIN ${q(schema)}._addresses at ON at.id = e.${q(c[1])}`
      : '';
    const extra = c ? `, ${hexOf('af.address')} AS t_from, ${hexOf('at.address')} AS t_to, e.${q(c[2])}::text AS t_value` : '';
    const r = await pool.query(
      `SELECT e.block_number, ${hexOf('e.tx_hash')} AS tx_hash, e.log_index${extra}
       FROM ${q(schema)}.${q(t.tableName)} e${joins}
       WHERE e.block_number BETWEEN $1 AND $2`,
      [from.toString(), to.toString()],
    );
```

(`capRange` is unchanged.) `insightTargets` keeps taking column names from `eventColumns` (now `from_id`, `to_id`, `value`).

Bench: `freshness.ts` reads `EXTRACT(EPOCH FROM (_ingested_at - block_time)) * 1000 AS ms, block_number FROM <schema>._blocks WHERE …` (one sample per block — every row of a block shares both times); `backfill.ts` reads `max(block_time) - min(block_time)` from `<schema>._blocks` over the range; `report.ts` text says freshness is per block from `_blocks`.

Fixtures: in `insights.test.ts`, `pipeline.test.ts`, `deadletter.test.ts` replace `block_time`/`tx_index` columns with `blockTime` beside `blockHash`, and address columns with `<name>_id` Buffers (e.g. insights `transferRow`: `from_id: b(WALLET), to_id: b(WALLET2)`; `depositRow`: `user_id: b(WALLET)`). Assertions that read `block_time` or addresses from event tables read them through `<table>_hex` or a join.

- [ ] **Step 4: Run** `corepack pnpm -r build && corepack pnpm --filter @arckive/worker test && corepack pnpm lint` — PASS.
- [ ] **Step 5: Commit** `feat(worker)!: resolve addresses to ids and write block time once per block`.

---

### Task 3: Insights — labels stored once, narrow `_insights`

**Files:**
- Modify: `packages/core/src/ddl.ts` (`buildInsightsTables`), `packages/worker/src/insightsdb.ts` (`commitInsights`)
- Test: `packages/core/test/ddl.test.ts`, `packages/core/test/insights-lanes.test.ts` (if it asserts `_insights` DDL), `packages/worker/test/insights.test.ts`

**Interfaces:**
- Produces: `buildInsightsTables(schema)` → `_sentences` (unchanged), `_labels`, `_insights` (dense), `_insights_lane_idx (lane, block_number)`, `_insights_cursor`, view `_insights_full` with columns `block_number, log_index, lane, lane_p, ruled, protocol, facts, sentence_id, sentence, model, probabilities`. `commitInsights` signature unchanged; per round with rows: sentence INSERT + SELECT, label INSERT + SELECT, `_insights` INSERT … RETURNING lane, cursor.

- [ ] **Step 1: Failing tests.** `ddl.test.ts`:

```ts
describe('buildInsightsTables (labels)', () => {
  const s = buildInsightsTables('idx_x');
  it('stores each label once and keeps rows to key, lane and label id', () => {
    const labels = s.find((x) => x.includes('"idx_x"._labels'))!;
    expect(labels).toContain('UNIQUE NULLS NOT DISTINCT (lane, lane_p, ruled, protocol, facts, sentence_id)');
    const insights = s.find((x) => x.includes('"idx_x"."_insights" ('))!;
    expect(insights).toContain('label_id integer NOT NULL');
    for (const gone of ['lane_p', 'ruled', 'protocol', 'facts', 'sentence_id', 'classified_at']) {
      expect(insights).not.toContain(gone);
    }
    expect(s).toContain('CREATE INDEX IF NOT EXISTS "_insights_lane_idx" ON "idx_x"."_insights" (lane, block_number)');
  });
});
```

`insights.test.ts` — keep every existing assertion that reads `_insights_full` (same column names); remove reads of `classified_at`; add:

```ts
  it('stores each label once, NULL protocol and lane_p included', async () => {
    // tx(2) and tx(4) share the same plain context: same ruled label
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), transferRow(103, 4, 0n)], [], 103n);
    await runInsightsOnce(deps, 'laya-test');
    const rows = await insights();
    const ruled = rows.filter((r) => r.ruled);
    expect(ruled).toHaveLength(2);
    const labels = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}._labels`);
    expect(labels.rows[0].n).toBe(2); // one answered label, one ruled label shared by two rows
    const raw = await pool.query(`SELECT label_id FROM ${SCHEMA}._insights ORDER BY block_number`);
    expect(raw.rows[1].label_id).toBe(raw.rows[2].label_id);
  });
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Core `buildInsightsTables`: `_sentences` as is; add

```sql
CREATE TABLE IF NOT EXISTS "<s>"._labels (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lane text NOT NULL,
  lane_p real,
  ruled boolean NOT NULL,
  protocol text,
  facts text[] NOT NULL,
  sentence_id integer NOT NULL,
  UNIQUE NULLS NOT DISTINCT (lane, lane_p, ruled, protocol, facts, sentence_id)
)
```

(comment: measured 517 distinct label tuples in 108,981 mainnet lane rows; `facts text[]` alone was 33 B/row; NULLS NOT DISTINCT needs PostgreSQL 15+), the dense `_insights`, the lane index, `_insights_cursor`, and

```sql
CREATE OR REPLACE VIEW "<s>"."_insights_full" AS
SELECT i.block_number, i.log_index, i.lane, l.lane_p, l.ruled, l.protocol, l.facts, l.sentence_id,
       s.sentence, NULLIF(s.model, '') AS model, s.probabilities
FROM "<s>"."_insights" i JOIN "<s>"._labels l ON l.id = i.label_id JOIN "<s>"._sentences s ON s.id = l.sentence_id
```

Worker `commitInsights`: after `sentenceIds`, resolve labels:

```ts
// Each label once, like sentences: one insert of the round's new label tuples
// and one select of all of them. lane_p and protocol may be NULL; the unique
// constraint treats NULLs as equal and the select matches them with IS NOT
// DISTINCT FROM, so a NULL-carrying label still resolves to one id.
async function labelIds(client, schema, rows, sentenceIdOf): Promise<Map<string, number>>
```

with input arrays `lane text[], lane_p real[], ruled boolean[], protocol text[], facts text[] (comma-joined), sentence_id integer[]` (deduped in JS by a key of all six), `INSERT INTO _labels (…) SELECT lane, p, ruled, protocol, CASE WHEN f = '' THEN '{}'::text[] ELSE string_to_array(f, ',') END, sid FROM unnest(…) AS u(lane, p, ruled, protocol, f, sid) ON CONFLICT (lane, lane_p, ruled, protocol, facts, sentence_id) DO NOTHING`, then `SELECT l.id, l.lane, l.lane_p, l.ruled, l.protocol, array_to_string(l.facts, ',') AS f, l.sentence_id FROM _labels l JOIN unnest(…) AS u(lane, p, ruled, protocol, f, sid) ON l.lane = u.lane AND l.lane_p IS NOT DISTINCT FROM u.p AND l.ruled = u.ruled AND l.protocol IS NOT DISTINCT FROM u.protocol AND l.facts = (CASE WHEN u.f = '' THEN '{}'::text[] ELSE string_to_array(u.f, ',') END) AND l.sentence_id = u.sid`. Key the returned map with the same six-part key built from the DB values (`lane_p` read back as a JS number from `real` equals the value JS sent once it went through the `real[]` cast — build the key from the DB row and look rows up after casting `laneP` with `Math.fround`). Insert `_insights` rows as `(block_number, log_index, lane, label_id) … ON CONFLICT (block_number, log_index) DO NOTHING RETURNING lane`.

- [ ] **Step 4: Run** `corepack pnpm -r build && corepack pnpm -r test && corepack pnpm lint` — PASS.
- [ ] **Step 5: Commit** `feat!: lane labels stored once; _insights keeps key, lane and label id`.

---

### Task 4: Rebuild a finished partition's indexes once

**Files:**
- Modify: `packages/worker/src/db.ts` (`Partitions` tracks rollover; new `Compactor`), `packages/worker/src/insights.ts` / `insightsdb.ts` (the `_insights` partitions use the same compactor), `packages/worker/src/main.ts` (one `Compactor` per process, `log`)
- Test: `packages/worker/test/db.test.ts`

**Interfaces:**
- Produces:
  - `class Compactor { constructor(pool: pg.Pool, log: Pick<Logger, 'info' | 'warn'>); enqueue(schema: string, partition: string): void; idle(): Promise<void> }` — runs `REINDEX TABLE CONCURRENTLY "<schema>"."<partition>"` one at a time in the background (outside any transaction); a failure is logged at warn and dropped; `idle()` resolves when the queue is empty (tests).
  - `Partitions` gains an optional constructor argument `onFinished?: (table: string, n: bigint) => void` and calls it, after COMMIT (from `remember`), for every partition `n` of a table that a committed batch moved past — only when this process had already written that table's partition `n` earlier (so a restart never revisits partitions finished before it).
  - `createStore(schema, defs, partitionBlocks, compactor?)` wires `onFinished` → `compactor.enqueue(schema, partitionName(table, n))`.

- [ ] **Step 1: Failing tests** (`db.test.ts`):

```ts
  it('rebuilds a finished partition once, when ingest moves past it', async () => {
    const enqueued: string[] = [];
    const s = createStore(SCHEMA, defs, 1000, { enqueue: (_schema: string, p: string) => enqueued.push(p) } as never);
    await commitBatch(pool, s, [row(10, 0)], [], 10n);
    await commitBatch(pool, s, [row(20, 0)], [], 20n);
    expect(enqueued).toEqual([]);
    await commitBatch(pool, s, [row(1000, 0)], [], 1000n);
    expect(enqueued.sort()).toEqual(['_blocks_p0', 'usdc_transfer_p0']);
    await commitBatch(pool, s, [row(1001, 0)], [], 1001n);
    expect(enqueued).toHaveLength(2);
  });

  it('a restart in the middle of a partition does not revisit the one before it', async () => {
    const enqueued: string[] = [];
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    await commitBatch(pool, store, [row(1000, 0)], [], 1000n); // first process moved into p1
    const restarted = createStore(SCHEMA, defs, 1000, { enqueue: (_s: string, p: string) => enqueued.push(p) } as never);
    await commitBatch(pool, restarted, [row(1500, 0)], [], 1500n);
    expect(enqueued).toEqual([]);
    await commitBatch(pool, restarted, [row(2000, 0)], [], 2000n);
    expect(enqueued.sort()).toEqual(['_blocks_p1', 'usdc_transfer_p1']);
  });

  it('Compactor rebuilds the partition indexes concurrently and survives a missing partition', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    const warned: unknown[] = [];
    const c = new Compactor(pool, { info: () => {}, warn: (o: unknown) => warned.push(o) });
    c.enqueue(SCHEMA, 'usdc_transfer_p0');
    c.enqueue(SCHEMA, 'usdc_transfer_p999');
    await c.idle();
    expect(warned).toHaveLength(1);
  });
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** `Partitions` keeps `lastSeen: Map<table, bigint>` (the highest partition this process has committed into). `plan` is unchanged; `remember(planned, blocks?)` — change to `committed(tables: readonly string[], blocks: Iterable<bigint>, planned: readonly PlannedPartition[])` called after COMMIT by `commitBatch`/`commitInsights`: remember `planned`, then for each table compute the batch's max partition `m`; if `lastSeen` has the table and `m > last`, call `onFinished(table, k)` for every `k` in `[last, m)`; set `lastSeen` to `max(last, m)` (first sight only records). Keep the existing "remember only after COMMIT" comment. `Compactor`:

```ts
// Rebuilds a finished partition's indexes once. Indexes grown row by row are
// looser than freshly built ones (measured on mainnet: from/to 26 → 20 B per
// row, tx_hash 36 → 32 rebuilt). REINDEX … CONCURRENTLY cannot run inside a
// transaction and must not hold up ingest, so it runs here, one at a time, in
// the background; a failure leaves a correct but looser index and is logged.
export class Compactor { … }
```

`main.ts`: `const compactor = new Compactor(pool, log);` passed to `createStore(…, compactor)` and to the insights `Partitions` (`new Partitions(schema, size, (t, n) => compactor.enqueue(schema, partitionName(t, n)))`) via `prepareInsights` input (add optional `compactor` to `PrepareInsightsInput`).

- [ ] **Step 4: Run** `corepack pnpm -r build && corepack pnpm --filter @arckive/worker test && corepack pnpm lint` — PASS.
- [ ] **Step 5: Commit** `feat(worker): rebuild a finished partition's indexes once, in the background`.

---

### Task 5: Docs

**Files:** `README.md` (Storage layout section, quickstart SQL examples, Insights SQL examples, the breaking-change callout stays), `CLAUDE.md` (Database schema bullets: dense columns, `_blocks` time, `_addresses`, `_labels`, btree `tx_hash`, compaction; Insights bullet: labels; PostgreSQL ≥ 15), `manifests/arc-mainnet/k8s/explorer.yaml` only if its comments mention removed columns.

- [ ] **Step 1:** Update every SQL example to the dense layout: address filters through `_addresses` ids (spec §4 example verbatim), block time through `_blocks` or `<table>_hex`, lanes through `_insights_full`. Add "PostgreSQL 15 or later" where requirements are listed.
- [ ] **Step 2:** `corepack pnpm lint && corepack pnpm -r build && corepack pnpm -r test`, `helm lint charts/arckive`, `scripts/build-install.sh && git diff --exit-code install.yaml`; grep README/CLAUDE.md for `block_time`, `tx_index`, `"from" =`, `classified_at` and fix stale uses.
- [ ] **Step 3: Commit** `docs: dense layout 2 — address ids, labels, block time in _blocks`.

---

### Task 6: Real test on k3d (controller)

Rebuild `arckive-worker`/`arckive-operator` images, import into k3d `arckive`, drop the layout-2 test schemas (`idx_arc_explorer`, `idx_usdc_arc`, `idx_flowswap`, `idx_arc_adaptive`) and re-index `arc-explorer` from block 24,745,323 with the Laya stub. Measure bytes per row (event tables, `_insights`, `_blocks`, `_addresses`, `_labels`, `_sentences`), compare the window 24,745,323–24,752,500 row-by-row against `idx_arc_explorer_v1` through `<table>_hex`, check statements per commit with `pg_stat_statements`, and record numbers in the spec's Measured section.
