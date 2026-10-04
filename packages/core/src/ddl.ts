import type { AbiEvent } from 'viem';
import type { EventDef } from './abi.js';
import { toSnakeCase } from './naming.js';

export class DdlError extends Error {}

export const COMMON_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['block_number', 'bigint NOT NULL'],
  ['block_hash', 'text NOT NULL'],
  ['block_time', 'timestamptz NOT NULL'],
  ['tx_hash', 'text NOT NULL'],
  ['tx_index', 'integer NOT NULL'],
  ['log_index', 'integer NOT NULL'],
  ['contract_address', 'text NOT NULL'],
];

// _ingested_at is filled in by the DB (DEFAULT now()); decode does not produce it,
// so it is not in COMMON_COLUMNS but is reserved to avoid name collisions.
export const INGESTED_AT = '_ingested_at';
const RESERVED = new Set([...COMMON_COLUMNS.map(([n]) => n), INGESTED_AT]);
const q = (id: string) => `"${id}"`;

export function pgTypeFor(abiType: string): string {
  if (abiType.endsWith(']')) return 'jsonb';
  if (abiType.startsWith('tuple')) return 'jsonb';
  if (abiType === 'address') return 'text';
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
  statements: string[];
}

export function buildEventTable(schema: string, def: EventDef): TableSpec {
  const cols = eventColumns(def.event);
  const lines = [
    ...COMMON_COLUMNS.map(([n, t]) => `${q(n)} ${t}`),
    `${q(INGESTED_AT)} timestamptz NOT NULL DEFAULT now()`,
    ...cols.map((c) => `${q(c.name)} ${pgTypeFor(c.abiType)}`),
    'UNIQUE (block_number, tx_hash, log_index)',
  ];
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(def.tableName)} (\n  ${lines.join(',\n  ')}\n)`,
    // idempotent migration for existing installs (old rows carry the migration timestamp)
    `ALTER TABLE ${q(schema)}.${q(def.tableName)} ` +
      `ADD COLUMN IF NOT EXISTS ${q(INGESTED_AT)} timestamptz NOT NULL DEFAULT now()`,
    ...cols
      .filter((c) => c.indexed)
      .map(
        (c) =>
          `CREATE INDEX IF NOT EXISTS ${q(`${def.tableName}_${c.name}_idx`)} ` +
          `ON ${q(schema)}.${q(def.tableName)} (${q(c.name)})`,
      ),
  ];
  return { schema, table: def.tableName, statements };
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
  ];
}

// Insights live beside the event tables, never in them: event tables keep
// their hot-path shape, and "not classified yet" is simply "no row". Keyed
// like the event rows, so any event table joins on (block_number, tx_hash,
// log_index).
export function buildInsightsTables(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q('_insights')} (
  block_number bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  table_name text NOT NULL,
  lane text NOT NULL,
  lane_p real,
  ruled boolean NOT NULL,
  protocol text NOT NULL,
  facts jsonb NOT NULL,
  probabilities jsonb,
  sentence text NOT NULL,
  model text,
  classified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (block_number, tx_hash, log_index)
)`,
    `CREATE INDEX IF NOT EXISTS ${q('_insights_lane_idx')} ON ${q(schema)}.${q('_insights')} (lane)`,
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q('_insights_cursor')} (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
  ];
}
