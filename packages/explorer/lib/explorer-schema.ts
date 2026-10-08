import type pg from 'pg';
import { SchemaError } from './schema.js';

// The explorer's own tables, in schema `explorer` (created with the role by
// explorer-role.sql, owned by it). IF NOT EXISTS: there are no migrations yet.
const STATEMENTS = [
  // USDC received and sent per address per UTC day: an address page's totals
  // and chart over the whole history, never a scan of its transfers.
  `CREATE TABLE IF NOT EXISTS explorer.address_daily (
  address_id integer NOT NULL,
  day date NOT NULL,
  in_value numeric NOT NULL DEFAULT 0,
  out_value numeric NOT NULL DEFAULT 0,
  in_count integer NOT NULL DEFAULT 0,
  out_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (address_id, day)
)`,
  // the last block folded into address_daily
  `CREATE TABLE IF NOT EXISTS explorer.rollup_cursor (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  block_number bigint NOT NULL
)`,
  // pool currencies' symbol() / decimals(), read once; nulls when the token answers neither
  `CREATE TABLE IF NOT EXISTS explorer.tokens (
  address bytea PRIMARY KEY,
  symbol text,
  decimals smallint,
  read_at timestamptz NOT NULL DEFAULT now()
)`,
];

export async function ensureExplorerSchema(pool: pg.Pool): Promise<void> {
  // CREATE SCHEMA needs CREATE on the database, which the role does not have
  const r = await pool.query<{ ok: boolean }>(`SELECT to_regnamespace('explorer') IS NOT NULL AS ok`);
  if (!r.rows[0]!.ok) throw new SchemaError('schema explorer is missing; apply manifests/arc-mainnet/k8s/explorer-role.sql');
  for (const s of STATEMENTS) await pool.query(s);
}
