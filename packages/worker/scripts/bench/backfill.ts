// Scenario 2 — Backfill: how fast real USDC history is caught up on Arc testnet.
// The worker starts head-N blocks behind; /metrics is sampled every 2 s and the
// run ends when healthz reports Live. The chain-time speedup is read from the
// block_time span of _blocks.
import pg from 'pg';
import { rpcHead, usdcAbi } from './freshness.ts';
import { rate } from './stats.ts';

const ARC_CHAIN_ID = 5042002;
const ARC_HTTP = 'https://arc-testnet.drpc.org'; // the official endpoint is rate-limited for queries (-32011)
const ARC_USDC = '0x3600000000000000000000000000000000000000';
import { healthz, metricValue, spawnWorker, stopWorker, waitFor, writeWorkerFiles } from './worker-proc.ts';

const PORT = 9302;
const BLOCKS = Number(process.env['BENCH_BACKFILL_BLOCKS'] ?? 5000);
const TIMEOUT_MS = Number(process.env['BENCH_BACKFILL_TIMEOUT_MS'] ?? 20 * 60_000);

export interface BackfillSample {
  tMs: number;
  block: number;
  events: number;
}

export interface BackfillResult {
  kind: 'backfill';
  network: 'arc-testnet';
  rpc: string[];
  contractAddress: string;
  startBlock: number;
  headAtStart: number;
  blocksPlanned: number;
  blocksProcessed: number;
  events: number;
  durationMs: number;
  blocksPerSec: number;
  eventsPerSec: number;
  chainSpanSec: number; // chain time of the processed range (block_time max-min)
  rpcErrors: number;
  series: BackfillSample[];
}

export async function run(databaseUrl: string): Promise<BackfillResult> {
  const head = await rpcHead(ARC_HTTP);
  const startBlock = head - BLOCKS;

  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query('DROP SCHEMA IF EXISTS idx_bench_backfill CASCADE');

  const configPath = writeWorkerFiles('backfill', { 'usdc-abi.json': usdcAbi() }, (dir) => ({
    indexerName: 'bench-backfill',
    network: { chainId: ARC_CHAIN_ID, rpc: [ARC_HTTP], finalityTag: 'latest' },
    contracts: [
      { name: 'usdc', address: ARC_USDC, abiPath: `${dir}/usdc-abi.json`, startBlock, events: ['Transfer'] },
    ],
    polling: { batchBlocks: 1000, intervalMs: 500 },
  }));

  const worker = spawnWorker(configPath, databaseUrl, PORT);
  const t0 = performance.now();
  const series: BackfillSample[] = [];
  try {
    await waitFor('worker healthz up', async () => (await healthz(PORT)) !== null, 60_000);

    await waitFor(
      'backfill reached Live',
      async () => {
        const h = await healthz(PORT);
        const block = (await metricValue(PORT, 'arckive_last_processed_block')) ?? 0;
        const events = (await metricValue(PORT, 'arckive_events_ingested_total')) ?? 0;
        if (block > 0) series.push({ tMs: Math.round(performance.now() - t0), block, events });
        if (h?.phase === 'Degraded') throw new Error(`worker Degraded: ${h.lastError ?? '?'}`);
        return h?.phase === 'Live';
      },
      TIMEOUT_MS,
      2000,
    );

    const durationMs = Math.round(performance.now() - t0);
    const last = series[series.length - 1]!;
    const processed = last.block - startBlock + 1;
    const rpcErrors = (await metricValue(PORT, 'arckive_rpc_errors_total')) ?? 0;
    const span = await db.query(
      `SELECT EXTRACT(EPOCH FROM (max(block_time) - min(block_time))) AS sec
         FROM idx_bench_backfill._blocks`,
    );
    return {
      kind: 'backfill',
      network: 'arc-testnet',
      rpc: [ARC_HTTP],
      contractAddress: ARC_USDC,
      startBlock,
      headAtStart: head,
      blocksPlanned: BLOCKS,
      blocksProcessed: processed,
      events: last.events,
      durationMs,
      blocksPerSec: Math.round(rate(processed, durationMs) * 10) / 10,
      eventsPerSec: Math.round(rate(last.events, durationMs) * 10) / 10,
      chainSpanSec: Math.round(Number(span.rows[0]?.sec ?? 0)),
      rpcErrors,
      series,
    };
  } finally {
    await stopWorker(worker);
    await db.end();
  }
}
