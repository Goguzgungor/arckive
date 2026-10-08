import pg from 'pg';
import type { Config } from './config.js';

export const q = (id: string): string => `"${id}"`;

// pg returns bigint and numeric columns as strings, which is what amounts
// need. The role's 5 s statement_timeout (explorer-role.sql) bounds every query.
export function createPool(cfg: Pick<Config, 'databaseUrl'>): pg.Pool {
  return new pg.Pool({ connectionString: cfg.databaseUrl, max: 10, application_name: 'arckive-explorer' });
}

export interface Tables {
  schema: string;
  usdc: string;
  blocks: string;
  addresses: string;
  cursor: string;
  insights: string;
  insightsCursor: string;
  insightsFull: string;
  swap: string;
  initialize: string;
  modifyLiquidity: string;
  donate: string;
  names: { usdc: string; swap: string; initialize: string; modifyLiquidity: string; donate: string };
}

// Quoted, schema-qualified names of the worker's tables; `names` holds the
// bare table names the start-up check looks for.
export function tables(cfg: Pick<Config, 'schema' | 'usdcTable' | 'poolPrefix'>): Tables {
  const s = (t: string): string => `${q(cfg.schema)}.${q(t)}`;
  const names = {
    usdc: cfg.usdcTable,
    swap: `${cfg.poolPrefix}swap`,
    initialize: `${cfg.poolPrefix}initialize`,
    modifyLiquidity: `${cfg.poolPrefix}modify_liquidity`,
    donate: `${cfg.poolPrefix}donate`,
  };
  return {
    schema: cfg.schema,
    usdc: s(names.usdc),
    blocks: s('_blocks'),
    addresses: s('_addresses'),
    cursor: s('_cursor'),
    insights: s('_insights'),
    insightsCursor: s('_insights_cursor'),
    insightsFull: s('_insights_full'),
    swap: s(names.swap),
    initialize: s(names.initialize),
    modifyLiquidity: s(names.modifyLiquidity),
    donate: s(names.donate),
    names,
  };
}

export const hexToBytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');
export const bytesToHex = (b: Buffer): string => `0x${b.toString('hex')}`;
