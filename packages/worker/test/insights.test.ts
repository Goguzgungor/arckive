import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { toFunctionSelector } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSFER_TOPIC, buildControlTables, extractEventDefs, parseWorkerConfig,
  type DecodedRow, type LaneAnswer, type TxContext,
} from '@arckive/core';
import { Partitions, bootstrap, commitBatch, contractMeta, createStore, initCursor, type Store } from '../src/db.js';
import {
  InsightsError, insightTargets, insightsStart, prepareInsights, runInsightsLoop, runInsightsOnce, type InsightsDeps,
} from '../src/insights.js';
import {
  bootstrapInsights, capRange, commitInsights, getInsightsCursor, initInsightsCursor, type InsightRow,
} from '../src/insightsdb.js';
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

const b = (h: string) => Buffer.from(h.slice(2), 'hex');
const common = (block: number, n: number) => ({
  block_number: String(block), tx_hash: b(tx(n)), log_index: n,
});
const transferRow = (block: number, n: number, value: bigint): DecodedRow => ({
  tableName: 'tok_transfer', blockHash: `0x${'bb'.repeat(32)}`, blockTime: new Date(0),
  columns: { ...common(block, n), from_id: b(WALLET), to_id: b(WALLET2), value: value.toString() },
});
const depositRow = (block: number, n: number): DecodedRow => ({
  tableName: 'vault_deposited', blockHash: `0x${'bb'.repeat(32)}`, blockTime: new Date(0),
  columns: { ...common(block, n), user_id: b(WALLET), amount: '5' },
});

const ctx = (over: Partial<TxContext>): TxContext => ({
  to: TOKEN, selector: '0xa9059cbb', topics: [TRANSFER_TOPIC], sender: WALLET,
  emitters: [TOKEN], factories: {}, ...over,
});

const askedParties: string[] = [];
function fakeContext(contexts: Record<string, TxContext | null>): ContextSource {
  return {
    contexts: async (txs) => new Map(txs.map((t) => [t.txHash, contexts[t.txHash] ?? null])),
    partyKinds: async (addrs) => {
      askedParties.push(...addrs);
      return Object.fromEntries(addrs.map((a) => [a, false]));
    },
  };
}

function fakePool() {
  return { backOffs: 0, backOffShared() { this.backOffs++; } };
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
  let store: Store;

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
    store = createStore(SCHEMA, defs, 1_000_000);
    await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], contractMeta(defs));
    await initCursor(pool, SCHEMA, 99n);
    await bootstrapInsights(pool, SCHEMA, 99n);
    classifier = fakeClassifier();
    deps = {
      pool, schema: SCHEMA,
      start: { cursor: 99n },
      targets: insightTargets(defs, new Map([[TOKEN, { label: 'TKN', decimals: 6 }]])),
      called: new Map([[VAULT, { name: 'vault', functions: new Map([['0x12345678', 'depositFor']]) }]]),
      context: fakeContext({
        [tx(1)]: ctx({ selector: '0x3593564c', to: UNIVERSAL_ROUTER, topics: [TRANSFER_TOPIC, V3_SWAP] }),
        [tx(2)]: ctx({}),
        [tx(3)]: ctx({ to: VAULT, selector: '0x12345678', topics: ['0x' + '77'.repeat(32), TRANSFER_TOPIC] }),
        [tx(5)]: ctx({ to: VAULT, selector: '0x12345678', topics: ['0x' + '77'.repeat(32)] }),
        [tx(4)]: ctx({}),
      }),
      classifier,
      metrics: createMetrics('ins'),
      log: pino({ level: 'silent' }),
      batchBlocks: 100,
      intervalMs: 60_000,
      wake: new HeadSignal(),
      ingestPhase: () => 'Live',
      rpcPool: fakePool(),
      partitions: new Partitions(SCHEMA, 1_000_000n),
    };
    askedParties.length = 0;
  });

  const insights = async () =>
    (await pool.query(`SELECT * FROM ${SCHEMA}._insights_full ORDER BY block_number, log_index`)).rows;

  it('classifies committed rows up to the ingest cursor and no further', async () => {
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), depositRow(102, 3)], [], 102n);
    await commitBatch(pool, store, [transferRow(103, 4, 1n)], [], 102n); // written, not yet committed past
    while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
    const rows = await insights();
    expect(rows.map((r) => [r.block_number, r.log_index])).toEqual([['100', 1], ['101', 2], ['102', 3]]);
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(102n);
  });

  it('rules what the transfer decides and asks the model the rest', async () => {
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), depositRow(102, 3)], [], 102n);
    await runInsightsOnce(deps, 'laya-test');
    const [swap, spam, deposit] = await insights();
    expect(swap).toMatchObject({ lane: 'swap', lane_p: 0.9, ruled: false, protocol: 'Uniswap', facts: ['swap'], model: 'laya-test' });
    expect(swap.probabilities).toEqual({ swap: 0.9, bridge: 0.1 });
    expect(swap.sentence).toBe('TKN moved from a wallet to a wallet, amount 1 to 100 TKN. In the same transaction: tokens were swapped on an exchange.');
    expect(spam).toMatchObject({ lane: 'spam', lane_p: null, ruled: true, probabilities: null, model: null });
    expect(deposit.sentence).toBe('The vault contract logged Deposited. It was called with depositFor. In the same transaction: nothing else recognisable happened.');
    expect(deposit).toMatchObject({ protocol: 'vault' });
    expect(classifier.asked.flat()).not.toContain(spam.sentence);
  });

  it('stores each sentence once and a ruled row with no protocol as NULL', async () => {
    // tx(2) and tx(4) share the same plain context, so their ruled sentences are equal
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), transferRow(103, 4, 0n)], [], 103n);
    await runInsightsOnce(deps, 'laya-test');
    const sentences = await pool.query(`SELECT sentence, model FROM ${SCHEMA}._sentences ORDER BY id`);
    expect(new Set(sentences.rows.map((r) => `${r.model}|${r.sentence}`)).size).toBe(sentences.rows.length);
    const ruled = (await insights()).filter((r) => r.ruled);
    expect(ruled).toHaveLength(2);
    expect(ruled[0].sentence_id).toBe(ruled[1].sentence_id);
    for (const r of ruled) expect(r).toMatchObject({ model: null, probabilities: null });
    const raw = await pool.query(`SELECT protocol FROM ${SCHEMA}._labels WHERE ruled`);
    expect(raw.rows.some((r) => r.protocol === '')).toBe(false);
  });

  it('stores each label once, NULL protocol and lane_p included', async () => {
    // tx(2) and tx(4) share the same plain context: same ruled label
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n), transferRow(101, 2, 0n), transferRow(103, 4, 0n)], [], 103n);
    await runInsightsOnce(deps, 'laya-test');
    const rows = await insights();
    const ruled = rows.filter((r) => r.ruled);
    expect(ruled).toHaveLength(2);
    const labels = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}._labels`);
    expect(labels.rows[0].n).toBe(2); // one answered label, one ruled label shared by two rows
    const raw = await pool.query(`SELECT label_id FROM ${SCHEMA}._insights ORDER BY block_number`);
    expect(raw.rows[1].label_id).toBe(raw.rows[2].label_id);
  });

  it('seeing the same labels again burns no label ids', async () => {
    const row = (logIndex: number, over: Partial<InsightRow> = {}): InsightRow => ({
      blockNumber: 100n, logIndex, lane: 'swap', laneP: 0.9, ruled: false,
      protocol: 'Uniswap', facts: ['swap', 'bridge'], probabilities: { swap: 0.9 }, sentence: 'same sentence', model: 'm', ...over,
    });
    const ruled = (logIndex: number) => row(logIndex, { lane: 'spam', laneP: null, ruled: true, protocol: '', facts: [], probabilities: null, model: '' });
    for (let i = 1; i <= 3; i++) await commitInsights(pool, SCHEMA, deps.partitions, [row(i), ruled(i + 10)], 100n);
    // a burned value shows only in the next id actually handed out
    await commitInsights(pool, SCHEMA, deps.partitions, [row(4, { lane: 'bridge' })], 100n);
    const r = await pool.query(`SELECT max(id)::int AS m, count(*)::int AS n FROM ${SCHEMA}._labels`);
    expect(r.rows[0]).toEqual({ m: 3, n: 3 });
    const full = await pool.query(`SELECT lane_p, protocol, facts FROM ${SCHEMA}._insights_full WHERE log_index = 1`);
    expect(full.rows[0]).toMatchObject({ protocol: 'Uniswap', facts: ['swap', 'bridge'] });
  });

  it('an answered sentence keeps its probabilities behind a ruled row with the same sentence', async () => {
    const row = (logIndex: number, probabilities: Record<string, number> | null): InsightRow => ({
      blockNumber: 100n, logIndex, lane: 'swap', laneP: probabilities ? 0.9 : null, ruled: !probabilities,
      protocol: '', facts: [], probabilities, sentence: 'same sentence', model: '',
    });
    await commitInsights(pool, SCHEMA, deps.partitions, [row(1, null)], 100n);
    await commitInsights(pool, SCHEMA, deps.partitions, [row(2, { swap: 0.9 })], 100n);
    const r = await pool.query(`SELECT probabilities FROM ${SCHEMA}._sentences WHERE sentence = 'same sentence'`);
    expect(r.rows).toEqual([{ probabilities: { swap: 0.9 } }]);
  });

  it('seeing the same sentences again burns no sentence ids', async () => {
    const row = (logIndex: number): InsightRow => ({
      blockNumber: 100n, logIndex, lane: 'swap', laneP: 0.9, ruled: false,
      protocol: '', facts: [], probabilities: { swap: 0.9 }, sentence: 'same sentence', model: 'm',
    });
    for (let i = 1; i <= 3; i++) await commitInsights(pool, SCHEMA, deps.partitions, [row(i)], 100n);
    // a burned value shows only in the next id actually handed out
    await commitInsights(pool, SCHEMA, deps.partitions, [{ ...row(4), sentence: 'another sentence' }], 100n);
    const r = await pool.query(`SELECT max(id)::int AS m, count(*)::int AS n FROM ${SCHEMA}._sentences`);
    expect(r.rows[0].m).toBe(r.rows[0].n);
  });

  it('a failed model call writes nothing and leaves the cursor', async () => {
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n)], [], 100n);
    classifier.state.fail = new LayaError('gate answered HTTP 503', 503);
    await expect(runInsightsOnce(deps, null)).rejects.toMatchObject({ stage: 'model' });
    expect(await insights()).toEqual([]);
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(99n);
  });

  it('re-running a range changes nothing', async () => {
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n), depositRow(101, 3)], [], 101n);
    await runInsightsOnce(deps, 'laya-test');
    await pool.query(`UPDATE ${SCHEMA}._insights_cursor SET last_block = 99`);
    await runInsightsOnce(deps, 'laya-test');
    expect(await insights()).toHaveLength(2);
  });

  it('caps a round by rows, taking an oversized block whole', async () => {
    await commitBatch(pool, store, [transferRow(100, 1, 1n), transferRow(100, 2, 1n), depositRow(101, 3), depositRow(103, 4)], [], 103n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 2)).toBe(100n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 3)).toBe(102n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 103n, 10)).toBe(103n);
    expect(await capRange(pool, SCHEMA, deps.targets, 100n, 100n, 1)).toBe(100n);
  });

  it('the loop keeps going through gate failures and counts them by stage', async () => {
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n)], [], 100n);
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
    await commitBatch(pool, store, [depositRow(100, 3)], [], 100n);
    (deps.wake as HeadSignal).notify();
    await expect.poll(async () => (await insights()).length, { timeout: 3_000 }).toBe(1);
    ctrl.abort();
    await loop;
  });

  it('prepareInsights creates the tables, reads token info and refuses a bad header', async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    store = createStore(SCHEMA, defs, 1_000_000);
    await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], contractMeta(defs));
    const cfg = parseWorkerConfig({
      indexerName: 'ins',
      network: { chainId: 31337, rpc: ['http://127.0.0.1:1'] },
      contracts: [
        { name: 'tok', address: TOKEN, abiInline: [], startBlock: 50 },
        { name: 'vault', address: VAULT, abiInline: [], startBlock: 70 },
      ],
      insights: { laya: { url: 'https://gate.example' } },
    });
    const vaultAbi = [{ type: 'function', name: 'depositFor', inputs: [], outputs: [], stateMutability: 'nonpayable' }];
    const base = {
      cfg, pool, schema: SCHEMA, defs, abis: [[], vaultAbi],
      metrics: createMetrics('prep'), log: pino({ level: 'silent' }), wake: new HeadSignal(),
      context: fakeContext({}), readToken: async () => ({ label: 'TKN', decimals: 6 }),
      ingestPhase: () => 'Live' as const, rpcPool: fakePool(),
    };
    await expect(prepareInsights({ ...base, headerLine: 'nonsense secret' })).rejects.toThrow(/INSIGHTS_HEADER/);
    const prepared = await prepareInsights({ ...base, headerLine: 'Authorization: Bearer x' });
    expect(await getInsightsCursor(pool, SCHEMA)).toBe(49n);
    expect(prepared.partitions.size).toBe(2_000_000n);
    expect(prepared.targets.find((t) => t.tableName === 'tok_transfer')?.token).toEqual({ label: 'TKN', decimals: 6 });
    expect(prepared.called.get(VAULT)?.functions.get(toFunctionSelector('depositFor()'))).toBe('depositFor');
  });

  it('waits while ingest is not Live, so ingest keeps the RPC to itself', async () => {
    let live = false;
    deps.ingestPhase = () => (live ? 'Live' : 'Backfilling');
    await commitBatch(pool, store, [depositRow(100, 3)], [], 100n);
    const ctrl = new AbortController();
    const loop = runInsightsLoop(deps, ctrl.signal);
    (deps.wake as HeadSignal).notify();
    await new Promise((r) => setTimeout(r, 300));
    expect(await insights()).toEqual([]);
    live = true;
    (deps.wake as HeadSignal).notify();
    await expect.poll(async () => (await insights()).length, { timeout: 3_000 }).toBe(1);
    ctrl.abort();
    await loop;
  });

  it('slows its RPC pace while ingest is Degraded', async () => {
    const pacer = fakePool();
    deps.rpcPool = pacer;
    deps.ingestPhase = () => 'Degraded';
    deps.intervalMs = 20;
    const ctrl = new AbortController();
    const loop = runInsightsLoop(deps, ctrl.signal);
    await expect.poll(() => pacer.backOffs, { timeout: 2_000 }).toBeGreaterThan(1);
    ctrl.abort();
    await loop;
  });

  it('takes a transaction’s sender for a wallet without asking the chain', async () => {
    // tx(1)'s sender is WALLET, the transfer's from; only WALLET2 needs asking
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n)], [], 100n);
    await runInsightsOnce(deps, 'laya-test');
    expect(askedParties).toEqual([WALLET2]);
    expect((await insights())[0].sentence).toMatch(/^TKN moved from a wallet to a wallet/);
  });

  it('a gate outage retries the model call only, never the chain reads', async () => {
    await commitBatch(pool, store, [transferRow(100, 1, 5_000_000n)], [], 100n);
    let reads = 0;
    const inner = deps.context;
    deps.context = { ...inner, contexts: (txs) => { reads++; return inner.contexts(txs); } };
    classifier.state.fail = new LayaError('gate answered HTTP 503', 503);
    const ctrl = new AbortController();
    const loop = runInsightsLoop(deps, ctrl.signal);
    await expect
      .poll(async () => (await deps.metrics.insightsErrors.get()).values.find((v) => v.labels.stage === 'model')?.value ?? 0, { timeout: 8_000 })
      .toBeGreaterThan(1);
    // ingest moves on meanwhile; the failed round must not grow to take it in
    await commitBatch(pool, store, [depositRow(101, 3)], [], 101n);
    classifier.state.fail = null;
    await expect.poll(async () => (await insights()).length, { timeout: 10_000 }).toBe(2);
    ctrl.abort();
    await loop;
    expect(reads).toBe(2); // the kept round (block 100), then the next one (block 101)
  });

  it('a transaction that moved nothing is ruled no_transfer and never asked', async () => {
    await commitBatch(pool, store, [depositRow(100, 5)], [], 100n);
    await runInsightsOnce(deps, 'laya-test');
    const [row] = await insights();
    expect(row).toMatchObject({ lane: 'no_transfer', ruled: true, lane_p: null, model: null });
    expect(classifier.asked.flat()).toEqual([]);
  });

  it('InsightsError names the stage that failed', () => {
    const err = new InsightsError('rpc', { cause: new Error('boom') });
    expect(err.stage).toBe('rpc');
    expect(err.message).toContain('boom');
  });
  describe('insights.startBlock', () => {
    const cfgWith = (startBlock?: number) => parseWorkerConfig({
      indexerName: 'ins',
      network: { chainId: 31337, rpc: ['http://127.0.0.1:1'] },
      contracts: [
        { name: 'tok', address: TOKEN, abiInline: [], startBlock: 50 },
        { name: 'vault', address: VAULT, abiInline: [], startBlock: 70 },
      ],
      insights: { laya: { url: 'https://gate.example' }, ...(startBlock === undefined ? {} : { startBlock }) },
    });

    // The ingest start in cfg is this boot's (main.ts resolves a tail-mode or
    // negative contract startBlock to this boot's head), so only an omitted
    // start follows it; set ones are floored at block 0.
    it('resolves to a cursor (block 0 at the earliest), or to "this far behind the head"', () => {
      expect(insightsStart(cfgWith())).toEqual({ cursor: 49n });
      expect(insightsStart(cfgWith(100))).toEqual({ cursor: 99n });
      expect(insightsStart(cfgWith(10))).toEqual({ cursor: 9n });
      expect(insightsStart(cfgWith(0))).toEqual({ cursor: -1n });
      expect(insightsStart(cfgWith(-5))).toEqual({ behindHead: 5n, floor: -1n });
    });

    it('relative: the first round writes the cursor that far behind the ingest cursor', async () => {
      await pool.query(`DELETE FROM ${SCHEMA}._insights_cursor`);
      deps.start = { behindHead: 5n, floor: -1n };
      await commitBatch(pool, store, [transferRow(110, 1, 5_000_000n), transferRow(118, 2, 1n)], [], 120n);
      while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
      expect((await insights()).map((r) => r.block_number)).toEqual(['118']); // 115 < 118, 110 skipped
      expect(await getInsightsCursor(pool, SCHEMA)).toBe(120n);
    });

    it('relative: more blocks than the chain has start at block 0', async () => {
      await pool.query(`DELETE FROM ${SCHEMA}._insights_cursor`);
      deps.start = { behindHead: 1_000n, floor: -1n };
      await commitBatch(pool, store, [transferRow(110, 1, 5_000_000n), transferRow(118, 2, 1n)], [], 120n);
      while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
      expect((await insights()).map((r) => r.block_number)).toEqual(['110', '118']);
    });

    it('an existing cursor is never moved by the start setting', async () => {
      deps.start = { behindHead: 5n, floor: -1n }; // beforeEach already wrote cursor 99
      await commitBatch(pool, store, [transferRow(110, 1, 5_000_000n)], [], 120n);
      while (await runInsightsOnce(deps, 'laya-test')) { /* catch up */ }
      expect((await insights()).map((r) => r.block_number)).toEqual(['110']);
      await initInsightsCursor(pool, SCHEMA, 7n);
      expect(await getInsightsCursor(pool, SCHEMA)).toBe(120n);
    });

    it('prepareInsights writes an absolute start at once and a relative one not yet', async () => {
      const base = {
        pool, schema: SCHEMA, defs, abis: [[], []],
        metrics: createMetrics('start'), log: pino({ level: 'silent' }), wake: new HeadSignal(),
        context: fakeContext({}), readToken: async () => ({ label: 'TKN', decimals: 6 }),
        ingestPhase: () => 'Live' as const, rpcPool: fakePool(), headerLine: undefined,
      };
      await pool.query(`DELETE FROM ${SCHEMA}._insights_cursor`);
      await prepareInsights({ ...base, cfg: cfgWith(-5) });
      expect(await getInsightsCursor(pool, SCHEMA)).toBeNull();
      await prepareInsights({ ...base, cfg: cfgWith(60) });
      expect(await getInsightsCursor(pool, SCHEMA)).toBe(59n);
      // below this boot's ingest start (49): written as set, not raised to it
      await pool.query(`DELETE FROM ${SCHEMA}._insights_cursor`);
      await prepareInsights({ ...base, cfg: cfgWith(10) });
      expect(await getInsightsCursor(pool, SCHEMA)).toBe(9n);
    });
  });
});
