import type pg from 'pg';
import type { Logger } from 'pino';
import type { PublicClient } from 'viem';
import {
  buildControlTables, buildEventTable, decodeLogToRow, planRange,
  type DecodedRow, type EventDef, type RawLog, type WorkerConfig,
} from '@arckive/core';
import { bootstrap, commitBatch, getCursor, initCursor, type DeadLetterEntry } from './db.js';
import { fetchLogs, getBlockTimes, getFinalizedBlockNumber } from './rpc.js';
import type { Metrics } from './metrics.js';
import type { HeadSignal } from './signal.js';
import type { PhaseTracker } from './status.js';

export interface PipelineDeps {
  client: PublicClient;
  pool: pg.Pool;
  cfg: WorkerConfig;
  defs: EventDef[];
  schema: string;
  metrics: Metrics;
  phase: PhaseTracker;
  headSignal: HeadSignal;
  log: Logger;
  // Called after every committed range; the insight loop waits on it so it
  // follows ingest without polling. The only thing ingest knows about insights.
  onCommitted?: () => void;
}

// startBlock is resolved to a concrete number in main.ts (undefined -> head),
// so the cursor starts just before the earliest contract's first block.
export function initialCursor(cfg: WorkerConfig): bigint {
  const startOf = (c: { startBlock?: number }) => BigInt(c.startBlock ?? 0);
  const minStart = cfg.contracts.reduce(
    (min, c) => (startOf(c) < min ? startOf(c) : min),
    startOf(cfg.contracts[0]!),
  );
  return minStart - 1n;
}

export async function bootstrapIndexer(deps: PipelineDeps): Promise<void> {
  const tables = deps.defs.map((d) => buildEventTable(deps.schema, d));
  await bootstrap(deps.pool, buildControlTables(deps.schema), tables);
  await initCursor(deps.pool, deps.schema, initialCursor(deps.cfg));
}

export async function runOnce(deps: PipelineDeps): Promise<boolean> {
  const { client, pool, cfg, defs, schema, metrics, phase } = deps;
  const cursor = await getCursor(pool, schema);
  if (cursor === null) throw new Error('no cursor — call bootstrapIndexer first');
  // In 'latest' mode the target comes from the head announced by the primary
  // WS: the getBlock RTT and the announcing-node/query-node divergence (missed
  // signal → intervalMs delay) disappear. If the signal is missing or stale,
  // we fall back to the RPC.
  const signalHead =
    cfg.network.finalityTag === 'latest' ? deps.headSignal.latestPrimaryHead() : null;
  const finalized =
    signalHead && signalHead.number > cursor
      ? signalHead.number
      : await getFinalizedBlockNumber(client, cfg.network.finalityTag);
  metrics.blocksBehind.set(Number(finalized - cursor));
  phase.setBlocks(cursor, finalized);

  const range = planRange(cursor, finalized, cfg.polling.batchBlocks);
  if (!range) {
    phase.set('Live');
    return false;
  }
  phase.set('Backfilling');

  const byKey = new Map(defs.map((d) => [`${d.address}:${d.topic0}`, d]));
  const startBlocks = new Map(cfg.contracts.map((c) => [c.address.toLowerCase(), BigInt(c.startBlock ?? 0)]));
  const addresses = [...new Set(defs.map((d) => d.address))];

  // Completeness guard: if the target came from the signal, the query node
  // (LB) may lag behind the announced block — getLogs' silently-incomplete
  // response cannot be trusted. The blockNumber guard runs IN PARALLEL with
  // getLogs (no extra latency); if the node is lagging, only the part it has
  // seen is committed and the rest goes to the next round.
  let logs;
  let safeTo = range.toBlock;
  if (signalHead && finalized === signalHead.number) {
    const [fetched, queryHead] = await Promise.all([
      fetchLogs(client, addresses, range.fromBlock, range.toBlock),
      getFinalizedBlockNumber(client, cfg.network.finalityTag),
    ]);
    if (queryHead < range.fromBlock) return false; // node too far behind — skip this round
    safeTo = queryHead < range.toBlock ? queryHead : range.toBlock;
    logs = fetched.filter((l) => l.blockNumber! <= safeTo);
  } else {
    logs = await fetchLogs(client, addresses, range.fromBlock, range.toBlock);
  }
  // the cache fed from the newHeads payload answers with zero RTT in tail mode
  const times = await getBlockTimes(
    client,
    logs.map((l) => l.blockNumber!),
    deps.headSignal.blockTimes(),
  );

  const rows: DecodedRow[] = [];
  const dead: DeadLetterEntry[] = [];
  for (const log of logs) {
    const address = log.address.toLowerCase() as `0x${string}`;
    const def = byKey.get(`${address}:${log.topics[0]}`);
    if (!def) continue; // untracked event
    if (log.blockNumber! < (startBlocks.get(address) ?? 0n)) continue;
    try {
      rows.push(decodeLogToRow(def, log as unknown as RawLog, times.get(log.blockNumber!)!));
    } catch (err) {
      dead.push({
        blockNumber: log.blockNumber, txHash: log.transactionHash,
        logIndex: log.logIndex, address,
        topics: [...log.topics], data: log.data,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const end = deps.metrics.writeLatency.startTimer();
  const inserted = await commitBatch(pool, schema, rows, dead, safeTo);
  end();
  deps.onCommitted?.();

  metrics.eventsIngested.inc(inserted);
  metrics.deadLetters.inc(dead.length);
  metrics.lastProcessedBlock.set(Number(safeTo));
  metrics.blocksBehind.set(Number(finalized - safeTo));
  phase.setBlocks(safeTo, finalized);
  if (safeTo === finalized) phase.set('Live');
  deps.log.info(
    { fromBlock: range.fromBlock, toBlock: safeTo, inserted, dead: dead.length },
    'range processed',
  );
  return true;
}

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export async function runLoop(deps: PipelineDeps, signal: AbortSignal): Promise<void> {
  let backoffMs = 1000;
  while (!signal.aborted) {
    try {
      const progressed = await runOnce(deps);
      backoffMs = 1000;
      // idle: newHeads signal OR intervalMs (safety net) — whichever comes first
      if (!progressed) await deps.headSignal.wait(deps.cfg.polling.intervalMs, signal);
    } catch (err) {
      deps.metrics.rpcErrors.inc();
      deps.phase.set('Degraded', err instanceof Error ? err.message : String(err));
      deps.log.error({ err }, 'pipeline error — retrying with backoff');
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
}
