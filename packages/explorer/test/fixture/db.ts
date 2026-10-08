// A PostgreSQL 17 with the explorer's Indexer schema built by core's DDL (the
// statements the worker's bootstrap runs; the worker itself is not imported,
// to keep the dependency direction explorer → core), the fixture rows, and
// the explorer role from the real explorer-role.sql. Relative imports carry
// .ts: smoke/serve.ts runs this file under Node's type stripping.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  buildControlTables, buildEventTable, buildInsightsTables, extractEventDefs, partitionDdl, type EventDef,
} from '@arckive/core';
import * as R from './rows.ts';

const TRANSFER_ABI = [
  { type: 'event', name: 'Transfer', inputs: [
    { name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false }] },
];
const POOL_ABI = [
  { type: 'event', name: 'Initialize', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true }, { name: 'fee', type: 'uint24', indexed: false },
    { name: 'tickSpacing', type: 'int24', indexed: false }, { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'tick', type: 'int24', indexed: false }] },
  { type: 'event', name: 'ModifyLiquidity', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'tickLower', type: 'int24', indexed: false }, { name: 'tickUpper', type: 'int24', indexed: false },
    { name: 'liquidityDelta', type: 'int256', indexed: false }, { name: 'salt', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'Swap', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'amount0', type: 'int128', indexed: false }, { name: 'amount1', type: 'int128', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false }, { name: 'fee', type: 'uint24', indexed: false }] },
  { type: 'event', name: 'Donate', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'amount0', type: 'uint256', indexed: false }, { name: 'amount1', type: 'uint256', indexed: false }] },
];

export const DEFS: EventDef[] = [
  ...extractEventDefs('usdc', R.NATIVE_USDC, TRANSFER_ABI),
  ...extractEventDefs('poolmanager', R.POOLMANAGER, POOL_ABI),
];
const ROLE_SQL = readFileSync(new URL('../../../../manifests/arc-mainnet/k8s/explorer-role.sql', import.meta.url), 'utf8');
const q = (id: string): string => `"${id}"`;
const S = q(R.SCHEMA);
const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');

export interface TestTables {
  schema: string; usdc: string; blocks: string; addresses: string; cursor: string; insights: string;
  insightsCursor: string; insightsFull: string; swap: string; initialize: string; modifyLiquidity: string; donate: string;
  names: { usdc: string; swap: string; initialize: string; modifyLiquidity: string; donate: string };
}

export interface TestDb {
  admin: pg.Pool;
  explorer: pg.Pool;
  adminUrl: string;
  explorerUrl: string;
  t: TestTables;
  stop(): Promise<void>;
}

function testTables(): TestTables {
  const s = (t: string): string => `${S}.${q(t)}`;
  const names = { usdc: 'usdc_transfer', swap: 'poolmanager_swap', initialize: 'poolmanager_initialize', modifyLiquidity: 'poolmanager_modify_liquidity', donate: 'poolmanager_donate' };
  return {
    schema: R.SCHEMA, usdc: s(names.usdc), blocks: s('_blocks'), addresses: s('_addresses'), cursor: s('_cursor'),
    insights: s('_insights'), insightsCursor: s('_insights_cursor'), insightsFull: s('_insights_full'),
    swap: s(names.swap), initialize: s(names.initialize), modifyLiquidity: s(names.modifyLiquidity), donate: s(names.donate), names,
  };
}

async function partitions(admin: pg.Pool, tables: string[], blocks: number[]): Promise<void> {
  const ns = [...new Set(blocks.map((n) => BigInt(n) / R.PARTITION_BLOCKS))];
  for (const table of tables) for (const n of ns) await admin.query(partitionDdl(R.SCHEMA, table, n, R.PARTITION_BLOCKS));
}

export async function addInsightsTables(admin: pg.Pool): Promise<void> {
  for (const s of buildInsightsTables(R.SCHEMA)) await admin.query(s);
  await partitions(admin, ['_insights'], R.BLOCKS.map((b) => b.n));
}

async function loadLanes(admin: pg.Pool): Promise<void> {
  for (const l of R.LANES) {
    const s = await admin.query<{ id: number }>(
      `INSERT INTO ${S}._sentences (sentence, model) VALUES ($1, $2) ON CONFLICT (sentence, model) DO UPDATE SET sentence = excluded.sentence RETURNING id`,
      [l.sentence, l.ruled ? '' : 'laya'],
    );
    const lab = await admin.query<{ id: number }>(
      `INSERT INTO ${S}._labels (lane, lane_p, ruled, protocol, facts, sentence_id) VALUES ($1, $2, $3, NULL, '{}', $4)
       ON CONFLICT (lane, lane_p, ruled, protocol, facts, sentence_id) DO UPDATE SET lane = excluded.lane RETURNING id`,
      [l.lane, l.p, l.ruled, s.rows[0]!.id],
    );
    await admin.query(`INSERT INTO ${S}._insights (block_number, log_index, lane, label_id) VALUES ($1, $2, $3, $4)`, [l.n, l.li, l.lane, lab.rows[0]!.id]);
  }
  await admin.query(`INSERT INTO ${S}._insights_cursor (id, last_block) VALUES (1, $1)`, [R.INSIGHTS_CURSOR]);
}

async function loadRows(admin: pg.Pool): Promise<void> {
  const addresses = [...new Set([
    ...R.TRANSFERS.flatMap((t) => [t.from, t.to]), ...R.SWAPS.map((s) => s.sender),
    ...R.INITS.flatMap((i) => [i.currency0, i.currency1, i.hooks]), ...R.MODIFIES.map((m) => m.sender), ...R.DONATES.map((d) => d.sender),
  ])];
  const id = new Map<string, number>();
  for (const addr of addresses) {
    const r = await admin.query<{ id: number }>(`INSERT INTO ${S}._addresses (address) VALUES ($1) RETURNING id`, [bytes(addr)]);
    id.set(addr, r.rows[0]!.id);
  }
  const ref = (addr: string): number => id.get(addr)!;
  for (const b of R.BLOCKS) {
    await admin.query(`INSERT INTO ${S}._blocks (block_number, block_hash, block_time) VALUES ($1, $2, $3)`, [b.n, bytes(`0x${b.n.toString(16).padStart(64, 'a')}`), b.time]);
  }
  for (const t of R.TRANSFERS) {
    await admin.query(`INSERT INTO ${S}.usdc_transfer (block_number, tx_hash, log_index, from_id, to_id, value) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.n, bytes(t.tx), t.li, ref(t.from), ref(t.to), t.value]);
  }
  for (const i of R.INITS) {
    await admin.query(`INSERT INTO ${S}.poolmanager_initialize (block_number, tx_hash, log_index, id, currency0_id, currency1_id, fee, tick_spacing, hooks_id, sqrt_price_x96, tick)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [i.n, bytes(i.tx), i.li, bytes(i.pool), ref(i.currency0), ref(i.currency1), i.fee, i.tickSpacing, ref(i.hooks), '29869335453848447162871957180171', 118651]);
  }
  for (const s of R.SWAPS) {
    await admin.query(`INSERT INTO ${S}.poolmanager_swap (block_number, tx_hash, log_index, id, sender_id, amount0, amount1, sqrt_price_x96, liquidity, tick, fee)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [s.n, bytes(s.tx), s.li, bytes(s.pool), ref(s.sender), s.amount0, s.amount1, '13271096871842896174976915886610', '2639229179487355546693978', 102425, s.fee]);
  }
  for (const m of R.MODIFIES) {
    await admin.query(`INSERT INTO ${S}.poolmanager_modify_liquidity (block_number, tx_hash, log_index, id, sender_id, tick_lower, tick_upper, liquidity_delta, salt)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.n, bytes(m.tx), m.li, bytes(m.pool), ref(m.sender), m.tickLower, m.tickUpper, m.liquidityDelta, bytes(`0x${'0'.repeat(64)}`)]);
  }
  for (const d of R.DONATES) {
    await admin.query(`INSERT INTO ${S}.poolmanager_donate (block_number, tx_hash, log_index, id, sender_id, amount0, amount1) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [d.n, bytes(d.tx), d.li, bytes(d.pool), ref(d.sender), d.amount0, d.amount1]);
  }
  await admin.query(`INSERT INTO ${S}._cursor (id, last_block) VALUES (1, $1)`, [R.CURSOR]);
}

export async function startDb(opts: { insights?: boolean } = {}): Promise<TestDb> {
  // the worker's role is the database owner, as in manifests/arc-mainnet/k8s/postgres.yaml
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withUsername('arckive').withPassword('arckive').withDatabase('explorer').start();
  const adminUrl = container.getConnectionUri();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  for (const s of buildControlTables(R.SCHEMA)) await admin.query(s);
  for (const def of DEFS) for (const s of buildEventTable(R.SCHEMA, def, { addressIndexes: true }).statements) await admin.query(s);
  await partitions(admin, [...DEFS.map((d) => d.tableName), '_blocks'], R.BLOCKS.map((b) => b.n));
  await loadRows(admin);
  if (opts.insights !== false) {
    await addInsightsTables(admin);
    await loadLanes(admin);
  }
  await admin.query(ROLE_SQL);
  await admin.query(`ALTER ROLE explorer PASSWORD 'explorer'`);
  const u = new URL(adminUrl);
  u.username = 'explorer';
  u.password = 'explorer';
  const explorerUrl = u.toString();
  const explorer = new pg.Pool({ connectionString: explorerUrl, max: 10 });
  return {
    admin, explorer, adminUrl, explorerUrl, t: testTables(),
    async stop() {
      await explorer.end();
      await admin.end();
      await container.stop();
    },
  };
}

export const ROLE = ROLE_SQL;
