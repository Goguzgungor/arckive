import type pg from 'pg';
import type { Logger } from 'pino';
import {
  describeEvent, eventColumns, extractFunctionNames, isTransferEvent, planRange, settleLane,
  type CallInfo, type Description, type EventDef, type LaneAnswer, type TokenInfo, type TxContext, type WorkerConfig,
} from '@arckive/core';
import { getCursor } from './db.js';
import {
  bootstrapInsights, capRange, commitInsights, getInsightsCursor, readEventRows,
  type EventRow, type EventSource, type InsightRow,
} from './insightsdb.js';
import { LayaClient, LayaError, parseHeaderLine } from './laya.js';
import type { Metrics } from './metrics.js';
import type { Pacer } from './pacer.js';
import { initialCursor, sleep } from './pipeline.js';
import type { Phase } from './status.js';
import type { ContextSource } from './txcontext.js';

// The insight loop runs behind the ingest cursor, never in front of it and
// never inside it: rows up to _cursor are complete (ingest commits rows and
// cursor together), and nothing here can slow or stop ingest. The model gate
// is shared and rate-limited and has been down for hours at a time; when it
// is, insights fall behind and catch up, and the indexer stays Live.

// One round's rows. Bounded so a dense backfill range is not one giant
// transaction and one huge burst of RPC calls.
export const MAX_ROWS_PER_ROUND = 2000;

export interface InsightTarget extends EventSource {
  contractName: string;
  address: string; // lowercase
  eventName: string;
  token: TokenInfo | null; // ERC-20-shaped Transfer events only
}

export interface CalledContract {
  name: string;
  functions: ReadonlyMap<string, string>; // selector -> function name
}

export type Classifier = Pick<LayaClient, 'classify' | 'identity'>;

export interface InsightsDeps {
  pool: pg.Pool;
  schema: string;
  targets: InsightTarget[];
  called: ReadonlyMap<string, CalledContract>; // indexed contract address -> name + functions
  context: ContextSource;
  classifier: Classifier;
  metrics: Metrics;
  log: Logger;
  batchBlocks: number;
  intervalMs: number;
  wake: { wait(ms: number, signal: AbortSignal): Promise<void> };
  // Read, never set: insights run only while ingest is Live. While it
  // backfills or is Degraded, the RPC budget is ingest's.
  ingestPhase: () => Phase;
  // the pacer every insight RPC call goes through (txcontext.ts)
  rpcPacer: Pick<Pacer, 'backOff'>;
}

export class InsightsError extends Error {
  readonly stage: 'model' | 'rpc' | 'db';
  constructor(stage: 'model' | 'rpc' | 'db', options: { cause: unknown }) {
    const cause = options.cause;
    super(`insights ${stage} stage failed: ${cause instanceof Error ? cause.message : String(cause)}`, options);
    this.name = 'InsightsError';
    this.stage = stage;
  }
}

async function at<T>(stage: InsightsError['stage'], work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    throw new InsightsError(stage, { cause });
  }
}

export function insightTargets(defs: EventDef[], tokens: ReadonlyMap<string, TokenInfo>): InsightTarget[] {
  return defs.map((d) => {
    const transfer = isTransferEvent(d);
    const cols = eventColumns(d.event);
    return {
      tableName: d.tableName,
      contractName: d.contractName,
      address: d.address,
      eventName: d.event.name,
      transferColumns: transfer ? ([cols[0]!.name, cols[1]!.name, cols[2]!.name] as const) : null,
      token: transfer ? (tokens.get(d.address) ?? { label: d.contractName, decimals: null }) : null,
    };
  });
}

function callOf(ctx: TxContext | null, called: ReadonlyMap<string, CalledContract>): CallInfo | null {
  const contract = ctx?.to ? called.get(ctx.to) : undefined;
  if (!ctx || !contract) return null;
  return { contract: contract.name, fn: contract.functions.get(ctx.selector) ?? null };
}

// One round's reading: the rows past the insights cursor, their transactions
// and the sentences describing them. Everything here is settled chain data,
// so a round whose model call fails can be retried from this unchanged.
export interface PreparedRound {
  ingested: bigint; // _cursor when the round was read
  fromBlock: bigint;
  toBlock: bigint;
  described: Array<{ row: EventRow; d: Description }>;
}

export async function prepareRound(deps: InsightsDeps): Promise<PreparedRound | null> {
  const { pool, schema, metrics } = deps;
  const [done, ingested] = await at('db', Promise.all([getInsightsCursor(pool, schema), getCursor(pool, schema)]));
  if (done === null || ingested === null) throw new Error('no insights cursor — call bootstrapInsights first');
  metrics.insightsBlocksBehind.set(Number(ingested > done ? ingested - done : 0n));
  const range = planRange(done, ingested, deps.batchBlocks);
  if (!range) return null;

  const toBlock = await at('db', capRange(pool, schema, deps.targets, range.fromBlock, range.toBlock, MAX_ROWS_PER_ROUND));
  const rows = await at('db', readEventRows(pool, schema, deps.targets, range.fromBlock, toBlock));
  const contexts = await at('rpc', deps.context.contexts(rows));
  // A transaction's sender is a wallet — a contract cannot send one, and an
  // EIP-7702 account counts as a wallet (txcontext.isContractCode) — so the
  // chain is asked only about the other parties.
  const senders: Record<string, boolean> = {};
  for (const c of contexts.values()) if (c) senders[c.sender] = false;
  const asked = await at('rpc', deps.context.partyKinds(
    rows
      .flatMap((r) => (r.transfer && contexts.get(r.txHash) ? [r.transfer.from, r.transfer.to] : []))
      .filter((a) => !Object.hasOwn(senders, a)),
  ));
  const parties = { ...asked, ...senders };

  const byTable = new Map(deps.targets.map((t) => [t.tableName, t]));
  const described = rows.map((row) => {
    const target = byTable.get(row.tableName)!;
    const ctx = contexts.get(row.txHash) ?? null;
    return {
      row,
      d: describeEvent({
        contractName: target.contractName,
        contractAddress: target.address,
        eventName: target.eventName,
        transfer: row.transfer,
        token: target.token,
        ctx,
        parties,
        call: callOf(ctx, deps.called),
      }),
    };
  });
  return { ingested, fromBlock: range.fromBlock, toBlock, described };
}

// The round's model call and its write: rows and cursor in one transaction.
export async function finishRound(deps: InsightsDeps, round: PreparedRound, model: string | null): Promise<void> {
  const { pool, schema, metrics } = deps;
  const { described, toBlock } = round;
  const ask = [...new Set(described.filter((x) => !x.d.ruled).map((x) => x.d.sentence))];
  const answers = ask.length ? await at('model', deps.classifier.classify(ask)) : new Map<string, LaneAnswer>();

  const insights: InsightRow[] = described.map(({ row, d }) => {
    const answer = d.ruled ? null : (answers.get(d.sentence) ?? null);
    const { lane, laneP } = settleLane(answer, d.ruled);
    return {
      blockNumber: row.blockNumber, txHash: row.txHash, logIndex: row.logIndex, tableName: row.tableName,
      lane, laneP, ruled: Boolean(d.ruled), protocol: d.protocol, facts: d.facts,
      probabilities: answer?.probabilities ?? null, sentence: d.sentence, model: answer ? model : null,
    };
  });
  const inserted = await at('db', commitInsights(pool, schema, insights, toBlock));

  for (const lane of inserted) metrics.insightsClassified.inc({ lane });
  metrics.insightsBlocksBehind.set(Number(round.ingested > toBlock ? round.ingested - toBlock : 0n));
  deps.log.info(
    { fromBlock: round.fromBlock, toBlock, rows: insights.length, asked: ask.length },
    'insights range processed',
  );
}

export async function runInsightsOnce(deps: InsightsDeps, model: string | null): Promise<boolean> {
  const round = await prepareRound(deps);
  if (!round) return false;
  await finishRound(deps, round, model);
  return true;
}

export async function runInsightsLoop(deps: InsightsDeps, signal: AbortSignal): Promise<void> {
  let model = await deps.classifier.identity();
  let backoffMs = 1000;
  let failing = false;
  let pending: PreparedRound | null = null;
  while (!signal.aborted) {
    const phase = deps.ingestPhase();
    if (phase !== 'Live') {
      // Degraded is ingest failing — often on the endpoint's rate limit, which
      // insights share — so insights slow down too; while it backfills they
      // only wait their turn.
      if (phase === 'Degraded') deps.rpcPacer.backOff();
      await deps.wake.wait(deps.intervalMs, signal);
      continue;
    }
    try {
      // A round whose model call failed is kept and retried as it was: its
      // blocks do not change, and re-reading them on every retry through a
      // gate outage would spend the RPC quota ingest depends on — on a range
      // that grows with every retry as ingest moves on.
      pending ??= await prepareRound(deps);
      const progressed = pending !== null;
      if (pending) {
        await finishRound(deps, pending, model);
        pending = null;
      }
      if (failing) {
        failing = false;
        model = (await deps.classifier.identity()) ?? model;
        deps.log.info({ model }, 'insights recovered');
      }
      backoffMs = 1000;
      if (!progressed) await deps.wake.wait(deps.intervalMs, signal);
    } catch (err) {
      // Never touches the phase: /healthz and the CR phase describe ingest,
      // and a gate that is down must not take the indexer out of service.
      const stage = err instanceof InsightsError ? err.stage : 'db';
      // only a failed model call keeps its round; anything else reads afresh
      if (stage !== 'model') pending = null;
      deps.metrics.insightsErrors.inc({ stage });
      const status = err instanceof InsightsError && err.cause instanceof LayaError ? err.cause.status : undefined;
      deps.log.error(
        { err, stage, ...(status === 401 || status === 403 ? { hint: 'the gate rejected INSIGHTS_HEADER' } : {}) },
        'insights round failed — retrying with backoff',
      );
      failing = true;
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

export interface PrepareInsightsInput {
  cfg: WorkerConfig;
  pool: pg.Pool;
  schema: string;
  defs: EventDef[];
  abis: unknown[]; // full ABIs, in cfg.contracts order
  metrics: Metrics;
  log: Logger;
  wake: InsightsDeps['wake'];
  context: ContextSource;
  readToken: (address: string, fallback: string) => Promise<TokenInfo>;
  headerLine: string | undefined; // INSIGHTS_HEADER
  ingestPhase: () => Phase;
  rpcPacer: Pick<Pacer, 'backOff'>;
  fetch?: typeof fetch;
}

export async function prepareInsights(input: PrepareInsightsInput): Promise<InsightsDeps> {
  const { cfg, metrics } = input;
  if (!cfg.insights) throw new Error('insights are not configured');
  const header = input.headerLine ? parseHeaderLine(input.headerLine) : null;
  const classifier = new LayaClient(cfg.insights.laya.url, header, {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    onCall: () => metrics.insightsModelCalls.inc(),
    onCacheHits: (n) => metrics.insightsCacheHits.inc(n),
  });

  const tokens = new Map<string, TokenInfo>();
  for (const d of input.defs) {
    if (isTransferEvent(d) && !tokens.has(d.address)) {
      const info = await input.readToken(d.address, d.contractName);
      if (info.decimals === null) {
        // amounts will only read zero or nonzero for this token
        input.log.warn({ contract: d.contractName, address: d.address }, 'insights: token decimals unreadable');
      }
      tokens.set(d.address, info);
    }
  }
  const called = new Map<string, CalledContract>(
    cfg.contracts.map((c, i) => [
      c.address.toLowerCase(),
      { name: c.name, functions: extractFunctionNames(input.abis[i]) },
    ]),
  );

  await bootstrapInsights(input.pool, input.schema, initialCursor(cfg));
  // names the header, never its value
  input.log.info(
    { url: cfg.insights.laya.url, header: header?.name ?? null, tokens: Object.fromEntries(tokens) },
    'insights enabled',
  );
  return {
    pool: input.pool,
    schema: input.schema,
    targets: insightTargets(input.defs, tokens),
    called,
    context: input.context,
    classifier,
    metrics,
    log: input.log,
    batchBlocks: cfg.polling.batchBlocks,
    intervalMs: cfg.polling.intervalMs,
    wake: input.wake,
    ingestPhase: input.ingestPhase,
    rpcPacer: input.rpcPacer,
  };
}
