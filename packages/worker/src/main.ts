import { readFileSync } from 'node:fs';
import pg from 'pg';
import { pino } from 'pino';
import {
  extractEventDefs, knownToken, parseWorkerConfig, schemaName, type EventDef,
} from '@arckive/core';
import { createStore } from './db.js';
import { createMetrics } from './metrics.js';
import { bootstrapIndexer, runLoop, type PipelineDeps } from './pipeline.js';
import { RangeSizer } from './rangesizer.js';
import { createRpc, filterHealthyRpcs, getFinalizedBlockNumber, splitRpcUrls } from './rpc.js';
import { resolveContractAbi } from './abi.js';
import { resolveStartBlock } from './blocks.js';
import { startHealthServer } from './health.js';
import { HeadSignal } from './signal.js';
import { PhaseTracker } from './status.js';
import { subscribeNewHeads } from './ws.js';
import { crStatusTargetFromEnv, startCrStatusLoop, type CrStatusTarget } from './crstatus.js';
import { prepareInsights, runInsightsLoop } from './insights.js';
import { Pacer } from './pacer.js';
import { INSIGHTS_RPC_PACE, createContextSource, createInsightsRpc, readTokenInfo } from './txcontext.js';

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

async function main(): Promise<void> {
  const dsn = process.env['DATABASE_URL'];
  if (!dsn) throw new Error('DATABASE_URL is required');
  const configPath = process.env['CONFIG_PATH'] ?? '/etc/arckive/config.json';
  const cfg = parseWorkerConfig(JSON.parse(readFileSync(configPath, 'utf8')));

  const metrics = createMetrics(cfg.indexerName);
  const phase = new PhaseTracker();
  const healthPort = Number(process.env['HEALTH_PORT'] ?? 9090);
  const server = startHealthServer(metrics, phase, healthPort);

  // Endpoints with a mismatched chainId or that are dead drop out of the pool;
  // if none remain, go Degraded and wait-retry
  let rpcs = await filterHealthyRpcs(cfg.network.rpc, cfg.network.chainId);
  while (rpcs.length === 0) {
    phase.set('Degraded', `no RPC endpoint matched chainId ${cfg.network.chainId}`);
    log.error({ rpc: cfg.network.rpc }, 'no healthy RPC — retrying in 30 s');
    await new Promise((r) => setTimeout(r, 30_000));
    rpcs = await filterHealthyRpcs(cfg.network.rpc, cfg.network.chainId);
  }

  const pool = new pg.Pool({ connectionString: dsn });
  const client = createRpc(rpcs);

  // Resolve head-relative/absent startBlocks to concrete blocks once, so the
  // pipeline sees plain numbers (undefined -> head; negative -> head + n).
  if (cfg.contracts.some((c) => c.startBlock === undefined || (c.startBlock ?? 0) < 0)) {
    const head = Number(await getFinalizedBlockNumber(client, cfg.network.finalityTag));
    for (const c of cfg.contracts) c.startBlock = resolveStartBlock(c.startBlock, head);
    log.info({ head }, 'resolved head-relative startBlock(s)');
  }

  // Resolve each contract's ABI: mounted file > inline > explorer auto-fetch.
  // Kept whole: insights also read the function names.
  const abis = await Promise.all(cfg.contracts.map((c) => resolveContractAbi(c, cfg.network.explorerApi)));
  const defs: EventDef[] = cfg.contracts.flatMap((c, i) =>
    extractEventDefs(c.name, c.address, abis[i], c.events.length ? c.events : undefined),
  );

  const headSignal = new HeadSignal();
  const deps: PipelineDeps = {
    client,
    pool,
    cfg,
    defs,
    schema: schemaName(cfg.indexerName),
    store: createStore(schemaName(cfg.indexerName), defs, cfg.storage.partitionBlocks),
    metrics,
    phase,
    headSignal,
    log,
    sizer: new RangeSizer(cfg.polling.batchBlocks),
  };
  await bootstrapIndexer(deps);

  // Insights (optional) run beside ingest, woken by each committed range.
  const insightsWake = new HeadSignal();
  const insightsPacer = new Pacer(INSIGHTS_RPC_PACE);
  const insights = cfg.insights
    ? await prepareInsights({
        cfg, pool, schema: deps.schema, defs, abis, metrics, log, wake: insightsWake,
        context: createContextSource(createInsightsRpc(rpcs), { pacer: insightsPacer }),
        // native USDC has no symbol()/decimals() to read (core insights/tokens.ts)
        readToken: async (address, fallback) =>
          knownToken(cfg.network.chainId, address) ?? readTokenInfo(client, address, fallback),
        headerLine: process.env['INSIGHTS_HEADER'],
        ingestPhase: () => phase.phase,
        rpcPacer: insightsPacer,
      })
    : null;
  if (insights) deps.onCommitted = () => insightsWake.notify();

  // When a ws endpoint exists, the newHeads subscription wakes the pipeline
  // immediately; polling intervalMs remains as a safety net. announceRpc
  // endpoints only listen (they never join the query pool) and, being at the
  // front of the list, are the primary signal source.
  const { ws: wsUrls } = splitRpcUrls(rpcs);
  const announceUrls = [...new Set([...cfg.network.announceRpc, ...wsUrls])];
  const subscription = announceUrls.length
    ? subscribeNewHeads({
        wsUrls: announceUrls,
        onHead: (head, primary) => {
          metrics.headNotifications.inc();
          headSignal.notify(head ?? undefined, primary);
        },
        onStateChange: (connected) => metrics.wsConnected.set(connected ? 1 : 0),
        log,
      })
    : null;
  if (!announceUrls.length) log.info('no ws RPC endpoint — polling-only mode');
  let crTarget: CrStatusTarget | null = null;
  try {
    crTarget = crStatusTargetFromEnv();
  } catch (err) {
    log.warn({ err }, 'could not set up CR status target — status patching disabled');
  }
  const stopCrStatus = crTarget ? startCrStatusLoop(crTarget, phase, log) : (): void => {};
  if (crTarget) log.info({ cr: `${crTarget.namespace}/${crTarget.name}` }, 'CR status patching enabled');
  log.info({ indexer: cfg.indexerName, schema: deps.schema, rpcs }, 'arckive worker started');

  const ctrl = new AbortController();
  const shutdown = () => {
    log.info('shutdown signal received');
    ctrl.abort();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await Promise.all([runLoop(deps, ctrl.signal), insights ? runInsightsLoop(insights, ctrl.signal) : null]);
  subscription?.close();
  stopCrStatus();
  server.close();
  await pool.end();
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
