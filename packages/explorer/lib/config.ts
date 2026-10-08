import { z } from 'zod';

export class ConfigError extends Error {}

// A SQL identifier the explorer quotes into its queries: lowercase, as the
// worker's naming writes it, so a typo stops the process here rather than
// surfacing as a 500 on the first page that needs the table.
const Ident = z.string().regex(/^[a-z_][a-z0-9_]*$/, 'must be a lowercase SQL identifier');

const EnvSchema = z.object({
  DATABASE_URL: z.string({ required_error: 'is required' }).min(1, 'is required'),
  ARCKIVE_SCHEMA: Ident.default('idx_arc_explorer'),
  USDC_TABLE: Ident.default('usdc_transfer'),
  POOL_TABLE_PREFIX: Ident.default('poolmanager_'),
  ARC_RPC: z.string().url().default('https://rpc.mainnet.arc.io'),
  LANE_HOLD_MS: z.coerce.number().int().min(0).max(60_000).default(8000),
  MAX_STREAMS: z.coerce.number().int().positive().default(2000),
});

export interface Config {
  databaseUrl: string;
  schema: string;
  usdcTable: string;
  poolPrefix: string;
  arcRpc: string;
  laneHoldMs: number;
  maxStreams: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // an exported-but-empty variable means "unset", not 0
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const r = EnvSchema.safeParse(present);
  if (!r.success) {
    // zod's messages name the variable and the rule, never the value: the DSN carries a password
    const why = r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
    throw new ConfigError(`explorer configuration: ${why}`);
  }
  const e = r.data;
  for (const name of [e.ARCKIVE_SCHEMA, e.USDC_TABLE, `${e.POOL_TABLE_PREFIX}modify_liquidity`]) {
    if (Buffer.byteLength(name) > 63) throw new ConfigError(`explorer configuration: ${name} exceeds 63 bytes`);
  }
  return {
    databaseUrl: e.DATABASE_URL,
    schema: e.ARCKIVE_SCHEMA,
    usdcTable: e.USDC_TABLE,
    poolPrefix: e.POOL_TABLE_PREFIX,
    arcRpc: e.ARC_RPC,
    laneHoldMs: e.LANE_HOLD_MS,
    maxStreams: e.MAX_STREAMS,
  };
}
