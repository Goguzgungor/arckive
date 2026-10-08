import type pg from 'pg';
import { bytesToHex, hexToBytes, type Tables } from './db.js';
import { laneWhy } from './lanewhy.js';
import type { LaneState } from './types.js';

export interface TxTransfer { li: number; from: string; to: string; value: string }
export interface TxSwap { li: number; pool: string; sender: string; amount0: string; amount1: string; fee: number }
export interface TxModify { li: number; pool: string; sender: string; tickLower: number; tickUpper: number; liquidityDelta: string }
export interface TxDonate { li: number; pool: string; sender: string; amount0: string; amount1: string }
export interface TxInit { li: number; pool: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
export interface PoolInfo { id: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }

export interface TxData {
  hash: string;
  block: number;
  time: number;
  transfers: TxTransfer[];
  swaps: TxSwap[];
  modifies: TxModify[];
  donates: TxDonate[];
  inits: TxInit[];
  pools: Record<string, PoolInfo>;
}

type Row = Record<string, unknown> & { b: string };

// Every indexed row sharing the hash, one query per table through its
// tx_hash index, then the block's time and the pools' Initialize rows.
export async function loadTx(pool: pg.Pool, t: Tables, hash: string): Promise<TxData | null> {
  const key = hexToBytes(hash);
  const [tr, sw, ml, dn, ini] = await Promise.all([
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, fa.address AS f, ta.address AS r, x.value::text AS v
       FROM ${t.usdc} x JOIN ${t.addresses} fa ON fa.id = x.from_id JOIN ${t.addresses} ta ON ta.id = x.to_id
       WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, a.address AS s, x.amount0::text AS a0, x.amount1::text AS a1, x.fee::int AS fee
       FROM ${t.swap} x JOIN ${t.addresses} a ON a.id = x.sender_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, a.address AS s, x.tick_lower::int AS lo, x.tick_upper::int AS hi, x.liquidity_delta::text AS d
       FROM ${t.modifyLiquidity} x JOIN ${t.addresses} a ON a.id = x.sender_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, a.address AS s, x.amount0::text AS a0, x.amount1::text AS a1
       FROM ${t.donate} x JOIN ${t.addresses} a ON a.id = x.sender_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, c0.address AS c0, c1.address AS c1, x.fee::int AS fee, x.tick_spacing::int AS ts, h.address AS h
       FROM ${t.initialize} x JOIN ${t.addresses} c0 ON c0.id = x.currency0_id JOIN ${t.addresses} c1 ON c1.id = x.currency1_id
       JOIN ${t.addresses} h ON h.id = x.hooks_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
  ]);
  const any = [tr, sw, ml, dn, ini].find((r) => r.rowCount)?.rows[0];
  if (!any) return null;
  const block = Number(any.b);
  const hex = (v: unknown): string => bytesToHex(v as Buffer);
  const tx: TxData = {
    hash,
    block,
    time: 0,
    transfers: tr.rows.map((r) => ({ li: r['li'] as number, from: hex(r['f']), to: hex(r['r']), value: r['v'] as string })),
    swaps: sw.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), sender: hex(r['s']), amount0: r['a0'] as string, amount1: r['a1'] as string, fee: r['fee'] as number })),
    modifies: ml.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), sender: hex(r['s']), tickLower: r['lo'] as number, tickUpper: r['hi'] as number, liquidityDelta: r['d'] as string })),
    donates: dn.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), sender: hex(r['s']), amount0: r['a0'] as string, amount1: r['a1'] as string })),
    inits: ini.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), currency0: hex(r['c0']), currency1: hex(r['c1']), fee: r['fee'] as number, tickSpacing: r['ts'] as number, hooks: hex(r['h']) })),
    pools: {},
  };
  const ids = [...new Set([...tx.swaps, ...tx.modifies, ...tx.donates, ...tx.inits].map((e) => e.pool))];
  const [time, pools] = await Promise.all([
    pool.query<{ t: string }>(`SELECT extract(epoch from block_time)::bigint::text AS t FROM ${t.blocks} WHERE block_number = $1`, [block]),
    ids.length
      ? pool.query<Row>(
          `SELECT x.block_number::text AS b, x.id, c0.address AS c0, c1.address AS c1, x.fee::int AS fee, x.tick_spacing::int AS ts, h.address AS h
           FROM ${t.initialize} x JOIN ${t.addresses} c0 ON c0.id = x.currency0_id JOIN ${t.addresses} c1 ON c1.id = x.currency1_id
           JOIN ${t.addresses} h ON h.id = x.hooks_id WHERE x.id = ANY($1::bytea[])`, [ids.map(hexToBytes)])
      : Promise.resolve({ rows: [] as Row[] }),
  ]);
  tx.time = time.rowCount ? Number(time.rows[0]!.t) : 0;
  for (const r of pools.rows) {
    const id = hex(r['id']);
    tx.pools[id] = { id, currency0: hex(r['c0']), currency1: hex(r['c1']), fee: r['fee'] as number, tickSpacing: r['ts'] as number, hooks: hex(r['h']) };
  }
  return tx;
}

export interface InsightsInfo {
  on: boolean;
  firstBlock: number | null; // the first block with a lane: older transactions predate lanes
  firstTime: number | null;
}

export async function loadInsightsInfo(pool: pg.Pool, t: Tables, on: boolean): Promise<InsightsInfo> {
  if (!on) return { on, firstBlock: null, firstTime: null };
  const r = await pool.query<{ n: string; t: string }>(
    `SELECT b.block_number::text AS n, extract(epoch from b.block_time)::bigint::text AS t FROM ${t.blocks} b
     WHERE b.block_number = (SELECT min(block_number) FROM ${t.insights})`,
  );
  return r.rowCount ? { on, firstBlock: Number(r.rows[0]!.n), firstTime: Number(r.rows[0]!.t) } : { on, firstBlock: null, firstTime: null };
}

// The row whose lane the page shows: the first USDC movement, else the first pool event.
export function laneOrder(tx: TxData): number[] {
  const pools = [...tx.swaps, ...tx.modifies, ...tx.donates, ...tx.inits].map((e) => e.li).sort((a, b) => a - b);
  return [...tx.transfers.map((e) => e.li), ...pools];
}

export async function loadLane(pool: pg.Pool, t: Tables, info: InsightsInfo, block: number, logIndices: number[]): Promise<LaneState> {
  if (!info.on) return { kind: 'off' };
  const r = await pool.query<{ li: number; lane: string; p: number | null; ruled: boolean; sentence: string }>(
    `SELECT log_index AS li, lane, lane_p AS p, ruled, sentence FROM ${t.insightsFull} WHERE block_number = $1 AND log_index = ANY($2::int[])`,
    [block, logIndices],
  );
  if (r.rowCount) {
    const row = [...r.rows].sort((a, b) => logIndices.indexOf(a.li) - logIndices.indexOf(b.li))[0]!;
    const p = row.p === null ? null : Math.round(row.p * 100) / 100;
    return { kind: 'read', lane: row.lane, p, ruled: row.ruled, sentence: row.sentence, why: laneWhy(row.lane, row.ruled) };
  }
  if (info.firstBlock !== null && block < info.firstBlock) return { kind: 'before', since: info.firstTime! };
  const c = await pool.query<{ n: string }>(`SELECT last_block::text AS n FROM ${t.insightsCursor} WHERE id = 1`);
  const read = c.rowCount ? Number(c.rows[0]!.n) : null;
  return read === null || block > read ? { kind: 'pending' } : { kind: 'none' };
}
