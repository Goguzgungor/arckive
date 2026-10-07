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

export interface EventColumn {
  name: string;
  abiType: string;
  indexed: boolean;
}

export function eventColumns(event: AbiEvent): EventColumn[] {
  const cols = event.inputs.map((param, i) => {
    let name = param.name ? toSnakeCase(param.name) : `arg${i}`;
    if (RESERVED.has(name)) name = `param_${name}`;
    return { name, abiType: param.type, indexed: param.indexed === true };
  });
  const dup = cols.map((c) => c.name).find((n, i, a) => a.indexOf(n) !== i);
  if (dup) throw new DdlError(`${event.name}: column name collision: ${dup}`);
  return cols;
}

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
