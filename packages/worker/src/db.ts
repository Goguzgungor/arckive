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

// Every _meta key written here is fixed for the schema's life: rows carry
// neither the contract address nor the partition span, so changing either
// would silently mix two contracts' events in one table or misplace rows
// against partition bounds. A mismatch is refused, never overwritten.
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
        `INSERT INTO ${q(schema)}._meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value],
      );
      const stored: string = (await client.query(`SELECT value FROM ${q(schema)}._meta WHERE key = $1`, [key])).rows[0].value;
      if (stored !== value) {
        throw new LayoutError(
          `schema ${schema} has ${key} = ${stored}, this Indexer has ${value}; drop the schema or rename the Indexer to re-index`,
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getCursor(pool: pg.Pool, schema: string): Promise<bigint | null> {
  const r = await pool.query(`SELECT last_block FROM ${q(schema)}._cursor WHERE id = 1`);
  return r.rowCount ? BigInt(r.rows[0].last_block) : null;
}

export async function initCursor(pool: pg.Pool, schema: string, lastBlock: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO ${q(schema)}._cursor (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [lastBlock.toString()],
  );
}

export interface DeadLetterEntry {
  blockNumber: bigint | null;
  txHash: string | null;
  logIndex: number | null;
  address: string | null;
  topics: string[];
  data: string | null;
  error: string;
}

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
