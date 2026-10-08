import pg from 'pg';
import type { Config } from './config.js';

export const q = (id: string): string => `"${id}"`;

export interface PoolOptions {
  max: number;
  // how long a query waits for a free client before it fails (the page's 503)
  connectionTimeoutMillis?: number;
}

// pg returns bigint and numeric columns as strings, which is what amounts
// need. Every query is bounded at 5 s by the client itself, not only by the
// role (explorer-role.sql): a DSN for another role must not lift the bound.
//
// Idle clients are kept for 5 minutes and probed with TCP keepalive: through
// the Cloudflare tunnel (manifests/arc-mainnet/dokploy) a new connection
// costs ~0.7 s, so pg's 10 s default would make the first page after a quiet
// spell pay it; keepalive finds a connection the tunnel dropped before a
// query does.
export function createPool(cfg: Pick<Config, 'databaseUrl'>, opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: opts.max,
    connectionTimeoutMillis: opts.connectionTimeoutMillis,
    idleTimeoutMillis: 300_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 5000,
    application_name: 'arckive-explorer',
  });
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
