import type { AbiEvent } from 'viem';
import type { EventDef } from './abi.js';
import { assertPgIdentifier, toSnakeCase } from './naming.js';

export class DdlError extends Error {}

// Storage layout 2: hashes are bytea, the block hash and time live once per
// block in _blocks, each address once in _addresses (event rows hold its id),
// the contract address once per table in _meta, and every row table is
// range-partitioned by block_number. A schema written by
// another layout is refused at bootstrap (worker db.ts), never mixed.
export const STORAGE_LAYOUT = '2';

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

// _ingested_at is filled in by the DB (DEFAULT now()) in _blocks. block_time,
// tx_index and _ingested_at are no longer event columns but stay reserved so a
// parameter cannot take the name of a column readers knew. block_time and
// _ingested_at are still seen in the _hex view (from _blocks); tx_index is not
// — it is only reserved.
export const INGESTED_AT = '_ingested_at';
const RESERVED = new Set([
  ...COMMON_COLUMNS.map((c) => c.name),
  'block_time',
  'tx_index',
  INGESTED_AT,
]);
const q = (id: string) => `"${id}"`;

// The widest partition number checked at bootstrap: block 10^6 · partitionBlocks
// is far past any chain's head, so a table that passes never meets a partition
// name it cannot have.
const WIDEST_PARTITION = 999_999n;

export function pgTypeFor(abiType: string): string {
  if (abiType.endsWith(']')) return 'jsonb';
  if (abiType.startsWith('tuple')) return 'jsonb';
  // the address's id in _addresses: 4 bytes, and each address is stored once
  if (abiType === 'address') return 'integer';
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
  // the column name readers see in the _hex view (differs from name for addresses)
  viewName: string;
}

export function eventColumns(event: AbiEvent): EventColumn[] {
  const cols = event.inputs.map((param, i) => {
    let name = param.name ? toSnakeCase(param.name) : `arg${i}`;
    if (RESERVED.has(name)) name = `param_${name}`;
    const isAddress = param.type === 'address';
    return {
      name: isAddress ? `${name}_id` : name,
      abiType: param.type,
      indexed: param.indexed === true,
      viewName: name,
    };
  });
  const dup = cols.map((c) => c.name).find((n, i, a) => a.indexOf(n) !== i);
  if (dup) throw new DdlError(`${event.name}: column name collision: ${dup}`);
  // an address `foo` is stored as foo_id but viewed as foo, so it can collide
  // with another parameter only in the view, where CREATE VIEW would fail
  const dupView = cols.map((c) => c.viewName).find((n, i, a) => a.indexOf(n) !== i);
  if (dupView) throw new DdlError(`${event.name}: view column name collision: ${dupView}`);
  return cols;
}

export interface TableSpec {
  schema: string;
  table: string;
  // every column a row supplies, in insert order; _ingested_at lives in _blocks
  columns: ColumnSpec[];
  statements: string[];
}

// For dashboards and exports: the same rows as before the dense layout, with
// block time and ingest time joined from _blocks, hashes as 0x text and address
// ids resolved through _addresses. Filters belong on the base table — a
// predicate on these text columns cannot use the indexes; readers join through
// the ids.
function hexView(schema: string, table: string, params: EventColumn[]): string {
  const view = assertPgIdentifier(`${table}_hex`);
  const joins: string[] = [];
  let n = 0;
  const select = [
    't."block_number"',
    'b."block_time"',
    `'0x' || encode(t."tx_hash", 'hex') AS "tx_hash"`,
    't."log_index"',
    `b.${q(INGESTED_AT)}`,
    ...params.map((c) => {
      if (c.abiType === 'address') {
        const a = `a${n++}`;
        joins.push(`LEFT JOIN ${q(schema)}."_addresses" ${a} ON ${a}."id" = t.${q(c.name)}`);
        return `'0x' || encode(${a}."address", 'hex') AS ${q(c.viewName)}`;
      }
      if (pgTypeFor(c.abiType) === 'bytea') return `'0x' || encode(t.${q(c.name)}, 'hex') AS ${q(c.name)}`;
      return `t.${q(c.name)}`;
    }),
  ];
  // LEFT JOIN: an event whose _blocks row is missing stays visible (with a NULL
  // block time) instead of silently vanishing; on PostgreSQL 16+ the planner
  // drops the join when no _blocks column is selected.
  return (
    `CREATE OR REPLACE VIEW ${q(schema)}.${q(view)} AS SELECT ${select.join(', ')} ` +
    `FROM ${q(schema)}.${q(table)} t LEFT JOIN ${q(schema)}."_blocks" b ON b."block_number" = t."block_number"` +
    (joins.length ? ` ${joins.join(' ')}` : '')
  );
}

export interface EventTableOptions {
  // storage.addressIndexes: see the index comment below
  addressIndexes?: boolean;
}

export function buildEventTable(schema: string, def: EventDef, opts: EventTableOptions = {}): TableSpec {
  assertPgIdentifier(`${def.tableName}_p${WIDEST_PARTITION}`);
  const params = eventColumns(def.event);
  const columns: ColumnSpec[] = [
    ...COMMON_COLUMNS,
    ...params.map((c): ColumnSpec => ({
      name: c.name,
      pgType: pgTypeFor(c.abiType),
      ...(c.abiType === 'address' ? { address: true as const } : {}),
    })),
  ];
  const t = `${q(schema)}.${q(def.tableName)}`;
  const lines = [
    ...COMMON_COLUMNS.map((c) => `${q(c.name)} ${c.pgType} NOT NULL`),
    ...params.map((c) => `${q(c.name)} ${pgTypeFor(c.abiType)}`),
    // logIndex is block-scoped, so the pair names a log chain-wide
    'PRIMARY KEY (block_number, log_index)',
  ];
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${t} (\n  ${lines.join(',\n  ')}\n) PARTITION BY RANGE (block_number)`,
    // btree, not hash: measured 29.1 B/row vs 31.8 fresh / 36.2 live for hash on
    // 170,045 mainnet rows — the btree deduplicates a transaction's ~2.6 rows
    `CREATE INDEX IF NOT EXISTS ${q(`${def.tableName}_tx_hash_idx`)} ON ${t} (tx_hash)`,
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
    hexView(schema, def.tableName, params),
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
    // One row per block that produced an indexed row: hash, time and ingest
    // time once, instead of in every row of every table.
    `CREATE TABLE IF NOT EXISTS ${q(schema)}._blocks (
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL,
  block_time timestamptz NOT NULL,
  _ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block_number)
) PARTITION BY RANGE (block_number)`,
    // Each address once; event rows hold the id. Not partitioned: it grows with
    // distinct addresses, not rows — 14,819 for 170,045 mainnet transfers.
    `CREATE TABLE IF NOT EXISTS ${q(schema)}._addresses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address bytea NOT NULL UNIQUE
)`,
  ];
}

// Insights live beside the event tables, never in them: event tables keep
// their hot-path shape, and "not classified yet" is simply "no row". Keyed
// like the event rows, so any event table joins on (block_number, log_index).
// The model's answer is a function of the sentence and the model, so it is
// stored once per (sentence, model) — model '' for ruled rows — and every
// label points at it.
// The rest of a row's answer (lane_p, ruled, protocol, facts, sentence) is
// stored once per distinct tuple in _labels, and an _insights row keeps only
// its key, its lane and a label id: measured on Arc mainnet, 108,981 lane rows
// held just 517 distinct label tuples, and facts text[] alone cost 33 B/row.
// UNIQUE NULLS NOT DISTINCT makes a NULL lane_p / protocol compare equal, so a
// label is one row; it needs PostgreSQL 15+.
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
    `CREATE TABLE IF NOT EXISTS ${s}._labels (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lane text NOT NULL,
  lane_p real,
  ruled boolean NOT NULL,
  protocol text,
  facts text[] NOT NULL,
  sentence_id integer NOT NULL,
  UNIQUE NULLS NOT DISTINCT (lane, lane_p, ruled, protocol, facts, sentence_id)
)`,
    `CREATE TABLE IF NOT EXISTS ${s}.${q('_insights')} (
  block_number bigint NOT NULL,
  log_index integer NOT NULL,
  lane text NOT NULL,
  label_id integer NOT NULL,
  PRIMARY KEY (block_number, log_index)
) PARTITION BY RANGE (block_number)`,
    // serves "the latest rows of a lane"
    `CREATE INDEX IF NOT EXISTS ${q('_insights_lane_idx')} ON ${s}.${q('_insights')} (lane, block_number)`,
    `CREATE TABLE IF NOT EXISTS ${s}.${q('_insights_cursor')} (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    // for plain SQL: each row with its label, sentence and the answer behind its lane
    `CREATE OR REPLACE VIEW ${s}.${q('_insights_full')} AS
SELECT i.block_number, i.log_index, i.lane, l.lane_p, l.ruled, l.protocol, l.facts, l.sentence_id,
       s.sentence, NULLIF(s.model, '') AS model, s.probabilities
FROM ${s}.${q('_insights')} i
JOIN ${s}._labels l ON l.id = i.label_id
JOIN ${s}._sentences s ON s.id = l.sentence_id`,
  ];
}
