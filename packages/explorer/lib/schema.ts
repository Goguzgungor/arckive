import type pg from 'pg';
import type { Tables } from './db.js';

export class SchemaError extends Error {}

function required(t: Tables): Record<string, string[]> {
  return {
    [t.names.usdc]: ['block_number', 'tx_hash', 'log_index', 'from_id', 'to_id', 'value'],
    _blocks: ['block_number', 'block_time', '_ingested_at'],
    _addresses: ['id', 'address'],
    _cursor: ['last_block'],
    [t.names.swap]: ['block_number', 'tx_hash', 'log_index', 'id', 'sender_id', 'amount0', 'amount1', 'fee'],
    [t.names.initialize]: ['block_number', 'tx_hash', 'log_index', 'id', 'currency0_id', 'currency1_id', 'fee', 'tick_spacing', 'hooks_id'],
    [t.names.modifyLiquidity]: ['block_number', 'tx_hash', 'log_index', 'id', 'sender_id', 'tick_lower', 'tick_upper', 'liquidity_delta'],
    [t.names.donate]: ['block_number', 'tx_hash', 'log_index', 'id', 'sender_id', 'amount0', 'amount1'],
  };
}

const INSIGHTS: Record<string, string[]> = {
  _insights: ['block_number', 'log_index', 'lane', 'label_id'],
  _insights_cursor: ['last_block'],
  _insights_full: ['block_number', 'log_index', 'lane', 'lane_p', 'ruled', 'sentence'],
};

async function columns(pool: pg.Pool, schema: string): Promise<Map<string, Set<string>>> {
  const r = await pool.query<{ table_name: string; column_name: string }>(
    'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1',
    [schema],
  );
  const out = new Map<string, Set<string>>();
  for (const row of r.rows) {
    if (!out.has(row.table_name)) out.set(row.table_name, new Set());
    out.get(row.table_name)!.add(row.column_name);
  }
  return out;
}

function gaps(have: Map<string, Set<string>>, want: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(want)) {
    const got = have.get(table);
    if (!got) out.push(table);
    else for (const c of cols) if (!got.has(c)) out.push(`${table}.${c}`);
  }
  return out;
}

// The tables and columns the explorer reads. A schema from another layout or
// a renamed contract stops the process here with the list, instead of a 500
// on the first page that needs them.
export async function checkSchema(pool: pg.Pool, t: Tables): Promise<void> {
  const missing = gaps(await columns(pool, t.schema), required(t));
  if (missing.length) {
    throw new SchemaError(
      `schema ${t.schema} lacks ${missing.join(', ')}; is the explorer's Indexer (manifests/arc-mainnet/k8s/explorer.yaml) running, and was explorer-role.sql applied after it?`,
    );
  }
}

// Lanes exist once the Indexer's insights have run; until then the explorer
// shows rows without lanes and never names the _insights tables in a query.
export async function hasInsights(pool: pg.Pool, t: Tables): Promise<boolean> {
  return gaps(await columns(pool, t.schema), INSIGHTS).length === 0;
}
