import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSFER_TOPIC, buildControlTables, buildEventTable, extractEventDefs,
  type DecodedRow, type LaneAnswer, type TxContext,
} from '@arckive/core';
import { bootstrap, commitBatch, initCursor } from '../src/db.js';
import {
  InsightsError, insightTargets, runInsightsLoop, runInsightsOnce, type InsightsDeps,
} from '../src/insights.js';
import { bootstrapInsights, capRange, getInsightsCursor } from '../src/insightsdb.js';
import { LayaError } from '../src/laya.js';
import { createMetrics } from '../src/metrics.js';
import { HeadSignal } from '../src/signal.js';
import type { ContextSource } from '../src/txcontext.js';

const SCHEMA = 'idx_ins';
const TOKEN = '0x' + '11'.repeat(20);
const VAULT = '0x' + '22'.repeat(20);
const WALLET = '0x' + 'a1'.repeat(20);
const WALLET2 = '0x' + 'a2'.repeat(20);
const UNIVERSAL_ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const defs = [
  ...extractEventDefs('tok', TOKEN, [{
    type: 'event', name: 'Transfer', inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  }]),
  ...extractEventDefs('vault', VAULT, [{
    type: 'event', name: 'Deposited', inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  }]),
];

const common = (block: number, n: number, contract: string) => ({
  block_number: String(block), block_hash: `0x${'bb'.repeat(32)}`, block_time: new Date(0),
  tx_hash: tx(n), tx_index: 0, log_index: n, contract_address: contract,
});
const transferRow = (block: number, n: number, value: bigint): DecodedRow => ({
  tableName: 'tok_transfer',
  columns: { ...common(block, n, TOKEN), from: WALLET, to: WALLET2, value: value.toString() },
});
const depositRow = (block: number, n: number): DecodedRow => ({
  tableName: 'vault_deposited',
  columns: { ...common(block, n, VAULT), user: WALLET, amount: '5' },
});

const ctx = (over: Partial<TxContext>): TxContext => ({
  to: TOKEN, selector: '0xa9059cbb', topics: [TRANSFER_TOPIC], sender: WALLET,
  emitters: [TOKEN], factories: {}, ...over,
});

function fakeContext(contexts: Record<string, TxContext | null>): ContextSource {
  return {
    contexts: async (hashes) => new Map(hashes.map((h) => [h, contexts[h] ?? null])),
    partyKinds: async (addrs) => Object.fromEntries(addrs.map((a) => [a, false])),
  };
}

function fakeClassifier() {
  const asked: string[][] = [];
  const state = { fail: null as Error | null };
  return {
    asked,
    state,
    classify: async (sentences: string[]) => {
      if (state.fail) throw state.fail;
      asked.push(sentences);
      return new Map<string, LaneAnswer>(sentences.map((s) => [s, { choice: 'swap', probabilities: { swap: 0.9, bridge: 0.1 } }]));
    },
    identity: async () => 'laya-test',
  };
}

describe('insights', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let classifier: ReturnType<typeof fakeClassifier>;
  let deps: InsightsDeps;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap(pool, buildControlTables(SCHEMA), defs.map((d) => buildEventTable(SCHEMA, d)));
    await initCursor(pool, SCHEMA, 99n);
    await bootstrapInsights(pool, SCHEMA, 99n);
    classifier = fakeClassifier();
    deps = {
      pool, schema: SCHEMA,
      targets: insightTargets(defs, new Map([[TOKEN, { label: 'TKN', decimals: 6 }]])),
      called: new Map([[VAULT, { name: 'vault', functions: new Map([['0x12345678', 'depositFor']]) }]]),
      context: fakeContext({
        [tx(1)]: ctx({ selector: '0x3593564c', to: UNIVERSAL_ROUTER, topics: [TRANSFER_TOPIC, V3_SWAP] }),
        [tx(2)]: ctx({}),
        [tx(3)]: ctx({ to: VAULT, selector: '0x12345678', topics: ['0x' + '77'.repeat(32)] }),
        [tx(4)]: ctx({}),
      }),
      classifier,
      metrics: createMetrics('ins'),
      log: pino({ level: 'silent' }),
      batchBlocks: 100,
      intervalMs: 60_000,
      wake: new HeadSignal(),
    };
  });

  const insights = async () =>
    (await pool.query(`SELECT * FROM ${SCHEMA}._insights ORDER BY block_number, log_index`)).rows;

  it('classifies committed rows up to the ingest cursor and no further', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), depositRow(102, 3)], [], 102n);
    await commitBatch(pool, SCHEMA, [transferRow(103, 4, 1n)], [], 102n); // written, not yet committed past
    while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
    const rows = await insights();
    expect(rows.map((r) => r.tx_hash)).toEqual([tx(1), tx(2), tx(3)]);
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(102n);
  });

  it('rules what the transfer decides and asks the model the rest', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), depositRow(102, 3)], [], 102n);
    await runInsightsOnce(deps, 'laya-test');
    const [swap, spam, deposit] = await insights();
    expect(swap).toMatchObject({ lane: 'swap', lane_p: 0.9, ruled: false, protocol: 'Uniswap', facts: ['swap'], model: 'laya-test' });
    expect(swap.probabilities).toEqual({ swap: 0.9, bridge: 0.1 });
    expect(swap.sentence).toBe('TKN moved from a wallet to a wallet, amount 1 to 100 TKN. In the same transaction: tokens were swapped on an exchange.');
    expect(spam).toMatchObject({ lane: 'spam', lane_p: null, ruled: true, probabilities: null, model: null });
    expect(deposit.sentence).toBe('The vault contract logged Deposited. It was called with depositFor. In the same transaction: nothing else recognisable happened.');
    expect(deposit).toMatchObject({ protocol: 'vault', table_name: 'vault_deposited' });
    expect(classifier.asked.flat()).not.toContain(spam.sentence);
  });

  it('a failed model call writes nothing and leaves the cursor', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n)], [], 100n);
    classifier.state.fail = new LayaError('gate answered HTTP 503', 503);
    await expect(runInsightsOnce(deps, null)).rejects.toMatchObject({ stage: 'model' });
    expect(await insights()).toEqual([]);
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(99n);
  });

  it('re-running a range changes nothing', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n), depositRow(101, 3)], [], 101n);
    await runInsightsOnce(deps, 'laya-test');
    await pool.query(`UPDATE ${SCHEMA}._insights_cursor SET last_block = 99`);
    await runInsightsOnce(deps, 'laya-test');
    expect(await insights()).toHaveLength(2);
  });

  it('caps a round by rows, taking an oversized block whole', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 1n), transferRow(100, 2, 1n), depositRow(101, 3), depositRow(103, 4)], [], 103n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 2)).toBe(100n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 3)).toBe(102n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 10)).toBe(103n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 100n, 1)).toBe(100n);
  });

  it('the loop keeps going through gate failures and counts them by stage', async () => {
    await commitBatch(pool, SCHEMA, [transferRow(100, 1, 5_000_000n)], [], 100n);
    classifier.state.fail = new LayaError('gate answered HTTP 401', 401);
    const ctrl = new AbortController();
    const loop = runInsightsLoop(deps, ctrl.signal);
    await expect
      .poll(async () => (await deps.metrics.insightsErrors.get()).values.find((v) => v.labels.stage === 'model')?.value ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(0);
    classifier.state.fail = null;
    await expect.poll(async () => (await insights()).length, { timeout: 10_000 }).toBe(1);
    ctrl.abort();
    await loop;
  });

  it('wakes as soon as ingest commits', async () => {
    const ctrl = new AbortController();
    const loop = runInsightsLoop(deps, ctrl.signal);
    await new Promise((r) => setTimeout(r, 200));
    await commitBatch(pool, SCHEMA, [depositRow(100, 3)], [], 100n);
    (deps.wake as HeadSignal).notify();
    await expect.poll(async () => (await insights()).length, { timeout: 3_000 }).toBe(1);
    ctrl.abort();
    await loop;
  });

  it('InsightsError names the stage that failed', () => {
    const err = new InsightsError('rpc', { cause: new Error('boom') });
    expect(err.stage).toBe('rpc');
    expect(err.message).toContain('boom');
  });
});
