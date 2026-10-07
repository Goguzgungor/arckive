// Scenario 1 — Freshness: block close → SQL row on a live network.
// The worker tails real USDC traffic in WS newHeads LISTENING mode (polling is
// only a safety net) and latency is read from the product's own meta columns:
// _blocks._ingested_at - _blocks.block_time, per block. No emitter: third-party traffic is measured.
// Network selection: BENCH_FRESH_NETWORK (default arc-testnet; arc-mainnet will be added once it launches)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { latencyStats, type LatencyStats } from './stats.ts';
import { healthz, metricValue, spawnWorker, stopWorker, waitFor, writeWorkerFiles } from './worker-proc.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');

export const NETWORKS = {
  'arc-testnet': {
    chainId: 5042002,
    // the official endpoint announces fastest but is strictly rate-limited for
    // queries (-32011): it only listens via announceRpc; queries go to drpc
    announceRpc: ['wss://rpc.testnet.arc.network'],
    rpc: ['wss://arc-testnet.drpc.org', 'https://arc-testnet.drpc.org'],
    usdc: '0x3600000000000000000000000000000000000000',
  },
  // arc-mainnet: to be added here once it launches (chainId + official endpoints + native USDC)
} as const;

export type FreshNetwork = keyof typeof NETWORKS;
export const FRESH_NETWORK = (process.env['BENCH_FRESH_NETWORK'] ?? 'arc-testnet') as FreshNetwork;
if (!(FRESH_NETWORK in NETWORKS)) throw new Error(`unknown network: ${FRESH_NETWORK}`);
export const PRIMARY_WS =
  NETWORKS[FRESH_NETWORK].announceRpc[0] ??
  NETWORKS[FRESH_NETWORK].rpc.find((u) => u.startsWith('ws'))!;

const PORT = 9301;
const SAMPLES = Number(process.env['BENCH_FRESH_SAMPLES'] ?? 40);
const INTERVAL_MS = Number(process.env['BENCH_FRESH_INTERVAL_MS'] ?? 2000);
const WINDOW_MS = Number(process.env['BENCH_FRESH_WINDOW_MS'] ?? 240_000);

export async function rpcHead(url: string): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { result?: string };
  if (!body.result) throw new Error(`eth_blockNumber returned empty: ${url}`);
  return Number(body.result);
}

export function usdcAbi(): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, 'manifests/arc-testnet/usdc-abi.json'), 'utf8'));
}

export interface FreshnessResult {
  kind: 'freshness';
  network: FreshNetwork;
  rpc: readonly string[];
  contractAddress: string;
  mode: 'ws-listening';
  headNotifications: number;
  rpcErrors: number;
  emitter: 'third-party traffic';
  stats: LatencyStats;
  samplesMs: number[];
  blockSpan: { from: number; to: number };
  durationMs: number;
}

export async function run(databaseUrl: string): Promise<FreshnessResult> {
  const net = NETWORKS[FRESH_NETWORK];
  const httpUrl = net.rpc.find((u) => u.startsWith('http'))!;
  const head = await rpcHead(httpUrl);

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query('DROP SCHEMA IF EXISTS idx_bench_fresh CASCADE');

  const configPath = writeWorkerFiles('fresh', { 'usdc-abi.json': usdcAbi() }, (dir) => ({
    indexerName: 'bench-fresh',
    network: {
      chainId: net.chainId, rpc: net.rpc, announceRpc: net.announceRpc, finalityTag: 'latest',
    },
    contracts: [
      { name: 'usdc', address: net.usdc, abiPath: `${dir}/usdc-abi.json`, startBlock: head, events: ['Transfer'] },
    ],
    polling: { batchBlocks: 1000, intervalMs: INTERVAL_MS }, // with WS up, the interval is a safety net
  }));

  const worker = spawnWorker(configPath, databaseUrl, PORT);
  const t0 = performance.now();
  try {
    await waitFor('worker healthz up', async () => (await healthz(PORT)) !== null, 60_000);
    // listening mode is mandatory: if WS never connected, the bench does not
    // report polling numbers — it fails
    await waitFor(
      'ws newHeads subscription (arckive_ws_connected=1)',
      async () => ((await metricValue(PORT, 'arckive_ws_connected')) ?? 0) === 1,
      30_000,
      500,
    );

    await waitFor(
      `${SAMPLES} usdc transfer rows in the window`,
      async () => {
        const h = await healthz(PORT);
        if (h?.phase === 'Degraded') throw new Error(`worker Degraded: ${h.lastError ?? '?'}`);
        try {
          const r = await db.query('SELECT count(*)::int AS n FROM idx_bench_fresh.usdc_transfer');
          return Number(r.rows[0]!.n) >= SAMPLES;
        } catch {
          return false; // the table may not be bootstrapped yet
        }
      },
      WINDOW_MS,
      1000,
    );
    await new Promise((r) => setTimeout(r, 2000)); // allowance for stragglers

    const wsStill = (await metricValue(PORT, 'arckive_ws_connected')) ?? 0;
    if (wsStill !== 1) throw new Error('WS connection was down at the end of the window — run invalid');
    const headNotifications = (await metricValue(PORT, 'arckive_head_notifications_total')) ?? 0;
    const rpcErrors = (await metricValue(PORT, 'arckive_rpc_errors_total')) ?? 0;

    const rows = await db.query(
      // one sample per block: every row of a block shares both times
      `SELECT EXTRACT(EPOCH FROM (_ingested_at - block_time)) * 1000 AS ms, block_number
         FROM idx_bench_fresh._blocks ORDER BY block_number`,
    );
    const samplesMs = rows.rows.map((r) => Math.round(Number(r.ms)));
    const blocks = rows.rows.map((r) => Number(r.block_number));
    return {
      kind: 'freshness',
      network: FRESH_NETWORK,
      rpc: net.rpc,
      contractAddress: net.usdc,
      mode: 'ws-listening',
      headNotifications,
      rpcErrors,
      emitter: 'third-party traffic',
      stats: latencyStats(samplesMs),
      samplesMs,
      blockSpan: { from: Math.min(...blocks), to: Math.max(...blocks) },
      durationMs: Math.round(performance.now() - t0),
    };
  } finally {
    await stopWorker(worker);
    await db.end();
  }
}
