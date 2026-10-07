import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractEventDefs, parseWorkerConfig, type WorkerConfig } from '@arckive/core';
import { createStore, getCursor } from '../src/db.js';
import { createMetrics } from '../src/metrics.js';
import { bootstrapIndexer, runLoop, runOnce, type PipelineDeps } from '../src/pipeline.js';
import { RangeSizer } from '../src/rangesizer.js';
import { createRpc, getBlockTimes } from '../src/rpc.js';
import { HeadSignal } from '../src/signal.js';
import { PhaseTracker } from '../src/status.js';
import { startAnvil, type AnvilHandle } from './helpers/anvil.js';

// anvil's well-known account #0
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FIXTURE = fileURLToPath(new URL('./fixtures/emitter', import.meta.url));

function loadArtifact() {
  const a = JSON.parse(
    readFileSync(`${FIXTURE}/out/Emitter.sol/Emitter.json`, 'utf8'),
  ) as { abi: unknown[]; bytecode: { object: `0x${string}` } };
  return a;
}

describe('pipeline', () => {
  let anvil: AnvilHandle;
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let deps: PipelineDeps;
  let contractAddress: `0x${string}`;

  beforeAll(async () => {
    execSync('forge build', { cwd: FIXTURE, stdio: 'inherit' });
    anvil = await startAnvil();
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });

    const artifact = loadArtifact();
    const wallet = createWalletClient({
      account: privateKeyToAccount(PK),
      transport: http(anvil.url),
    }).extend(publicActions);
    const hash = await wallet.deployContract({
      abi: artifact.abi as never, bytecode: artifact.bytecode.object, chain: null,
    });
    const receipt = await wallet.waitForTransactionReceipt({ hash });
    contractAddress = receipt.contractAddress!;
    // 5 pings → 5 events across 5 separate blocks
    for (let i = 1; i <= 5; i++) {
      const txHash = await wallet.writeContract({
        address: contractAddress, abi: artifact.abi as never,
        functionName: 'ping', args: [BigInt(i)], chain: null,
      });
      await wallet.waitForTransactionReceipt({ hash: txHash });
    }

    const cfg: WorkerConfig = parseWorkerConfig({
      indexerName: 'demo',
      network: { chainId: 31337, rpc: [anvil.url], finalityTag: 'latest' },
      contracts: [{ name: 'emitter', address: contractAddress, abiPath: 'unused' }],
      polling: { batchBlocks: 2, intervalMs: 100 },
    });
    const defs = extractEventDefs('emitter', contractAddress, artifact.abi);
    deps = {
      client: createRpc([anvil.url]),
      pool,
      cfg,
      defs,
      schema: 'idx_demo',
      store: createStore('idx_demo', defs, 1_000_000),
      metrics: createMetrics('demo'),
      phase: new PhaseTracker(),
      headSignal: new HeadSignal(),
      log: pino({ level: 'silent' }),
    };
    await bootstrapIndexer(deps);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
    anvil.stop();
  });

  it('with batchBlocks=2, processes range by range until caught up, writes 5 events', async () => {
    while (await runOnce(deps)) { /* until caught up */ }
    const r = await pool.query(`SELECT n, who FROM idx_demo.emitter_ping ORDER BY n`);
    expect(r.rows).toHaveLength(5);
    expect(r.rows.map((x) => x.n)).toEqual(['1', '2', '3', '4', '5']);
    expect(deps.phase.phase).toBe('Live');
  });

  it('idempotent: re-running produces no new rows', async () => {
    await runOnce(deps);
    const r = await pool.query(`SELECT count(*)::int AS c FROM idx_demo.emitter_ping`);
    expect(r.rows[0].c).toBe(5);
  });

  it('restart simulation: a fresh pipeline instance resumes from the cursor, no gaps/duplicates', async () => {
    const artifact = loadArtifact();
    const wallet = createWalletClient({
      account: privateKeyToAccount(PK), transport: http(anvil.url),
    }).extend(publicActions);
    for (let i = 6; i <= 8; i++) {
      const txHash = await wallet.writeContract({
        address: contractAddress, abi: artifact.abi as never,
        functionName: 'ping', args: [BigInt(i)], chain: null,
      });
      await wallet.waitForTransactionReceipt({ hash: txHash });
    }
    // "crash": old deps are discarded; an instance built from scratch on the same DB resumes
    const fresh: PipelineDeps = { ...deps, phase: new PhaseTracker(), metrics: createMetrics('demo2') };
    await bootstrapIndexer(fresh); // idempotent — does not touch the cursor
    while (await runOnce(fresh)) { /* catch up */ }
    const r = await pool.query(`SELECT count(*)::int AS c, max(n) AS m FROM idx_demo.emitter_ping`);
    expect(r.rows[0].c).toBe(8);
    expect(r.rows[0].m).toBe('8');
    const cursor = await getCursor(pool, 'idx_demo');
    expect(cursor).toBeGreaterThanOrEqual(8n);
  });

  it('runLoop: while idle, headSignal.notify() starts a new round without waiting intervalMs', async () => {
    const headSignal = new HeadSignal();
    const localDeps: PipelineDeps = {
      ...deps,
      headSignal,
      phase: new PhaseTracker(),
      metrics: createMetrics('demo3'),
      cfg: { ...deps.cfg, polling: { batchBlocks: 100, intervalMs: 60_000 } },
    };
    const ctrl = new AbortController();
    const loop = runLoop(localDeps, ctrl.signal);
    await new Promise((r) => setTimeout(r, 500)); // let it catch up and go idle

    // Produce the 9th event and signal — it must be processed before intervalMs (60 s) elapses
    const artifact = loadArtifact();
    const wallet = createWalletClient({
      account: privateKeyToAccount(PK), transport: http(anvil.url),
    }).extend(publicActions);
    const txHash = await wallet.writeContract({
      address: contractAddress, abi: artifact.abi as never,
      functionName: 'ping', args: [9n], chain: null,
    });
    await wallet.waitForTransactionReceipt({ hash: txHash });
    headSignal.notify();

    const t0 = Date.now();
    let count = 0;
    while (Date.now() - t0 < 5_000) {
      const r = await pool.query(`SELECT count(*)::int AS c FROM idx_demo.emitter_ping`);
      count = r.rows[0].c as number;
      if (count === 9) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    ctrl.abort();
    await loop;
    expect(count).toBe(9);
  });

  it("hot path: in 'latest' mode the target comes from the primary signal (not the head the guard sees)", async () => {
    const { HeadSignal: HS } = await import('../src/signal.js');
    const hs = new HS();
    const calls = { getBlock: 0 };
    const fake = {
      // guard call: the query node is at 5 — but the target must be 3 from the signal
      getBlock: async () => {
        calls.getBlock += 1;
        return { number: 5n };
      },
      getLogs: async () => [],
    } as unknown as PipelineDeps['client'];
    const cfg2 = parseWorkerConfig({
      indexerName: 'hot',
      network: { chainId: 31337, rpc: [anvil.url], finalityTag: 'latest' },
      contracts: [{ name: 'emitter', address: contractAddress, abiPath: 'unused' }],
      polling: { batchBlocks: 100, intervalMs: 100 },
    });
    const d2: PipelineDeps = {
      ...deps, client: fake, cfg: cfg2, schema: 'idx_hot', store: createStore('idx_hot', deps.defs, 1_000_000),
      headSignal: hs, metrics: createMetrics('hot'), phase: new PhaseTracker(),
    };
    await bootstrapIndexer(d2);
    hs.notify({ number: 3n, timestamp: new Date() }, true);
    expect(await runOnce(d2)).toBe(true);
    expect(calls.getBlock).toBe(1); // only the parallel completeness guard
    expect(await getCursor(pool, 'idx_hot')).toBe(3n); // not 5 — target comes from the signal
  });

  it('completeness guard: cursor is clamped when the query node lags behind the signal', async () => {
    const { HeadSignal: HS } = await import('../src/signal.js');
    const hs = new HS();
    const fake = {
      getBlock: async () => ({ number: 2n }), // node is at 2, signal says 5
      getLogs: async () => [],
    } as unknown as PipelineDeps['client'];
    const cfg2 = parseWorkerConfig({
      indexerName: 'clamp',
      network: { chainId: 31337, rpc: [anvil.url], finalityTag: 'latest' },
      contracts: [{ name: 'emitter', address: contractAddress, abiPath: 'unused' }],
      polling: { batchBlocks: 100, intervalMs: 100 },
    });
    const d2: PipelineDeps = {
      ...deps, client: fake, cfg: cfg2, schema: 'idx_clamp', store: createStore('idx_clamp', deps.defs, 1_000_000),
      headSignal: hs, metrics: createMetrics('clamp'), phase: new PhaseTracker(),
    };
    await bootstrapIndexer(d2);
    hs.notify({ number: 5n, timestamp: new Date() }, true);
    expect(await runOnce(d2)).toBe(true);
    expect(await getCursor(pool, 'idx_clamp')).toBe(2n); // unseen range is not committed
  });

  it('getBlockTimes: no RPC call is made for cached blocks', async () => {
    const client = {
      getBlock: async () => { throw new Error('must not be called when cache is populated'); },
    } as unknown as PipelineDeps['client'];
    const known = new Map([[5n, new Date(5000)]]);
    const times = await getBlockTimes(client, [5n, 5n], known);
    expect(times.get(5n)!.getTime()).toBe(5000);
  });

  it('tells onCommitted after each committed range, and only then', async () => {
    let calls = 0;
    const withHook: PipelineDeps = { ...deps, onCommitted: () => calls++ };
    while (await runOnce(withHook)) { /* catch up */ }
    const before = calls;
    await runOnce(withHook); // nothing new
    expect(calls).toBe(before);
    const artifact = loadArtifact();
    const wallet = createWalletClient({ account: privateKeyToAccount(PK), transport: http(anvil.url) }).extend(publicActions);
    const txHash = await wallet.writeContract({
      address: contractAddress, abi: artifact.abi as never, functionName: 'ping', args: [99n], chain: null,
    });
    await wallet.waitForTransactionReceipt({ hash: txHash });
    while (await runOnce(withHook)) { /* catch up */ }
    expect(calls).toBeGreaterThan(before);
  });

  it('a provider range cap shrinks the span without going Degraded, and every event still lands', async () => {
    const real = deps.client;
    const capped = {
      ...real,
      getLogs: (args: { fromBlock: bigint; toBlock: bigint }) =>
        args.toBlock - args.fromBlock + 1n > 2n
          ? Promise.reject(new Error('ranges over 10000 blocks are not supported on free plan'))
          : real.getLogs(args as never),
    } as unknown as PipelineDeps['client'];
    const schema = 'idx_capped';
    const sizer = new RangeSizer(1000);
    const d: PipelineDeps = {
      ...deps,
      client: capped,
      schema,
      store: createStore(schema, deps.defs, 1_000_000),
      cfg: { ...deps.cfg, polling: { ...deps.cfg.polling, batchBlocks: 1000 } },
      phase: new PhaseTracker(),
      sizer,
    };
    await bootstrapIndexer(d);
    let rounds = 0;
    while ((await runOnce(d)) && rounds++ < 200) {
      expect(d.phase.phase).not.toBe('Degraded');
    }
    const r = await pool.query(`SELECT count(*)::int AS c FROM ${schema}.emitter_ping`);
    expect(r.rows[0].c).toBeGreaterThanOrEqual(5);
    expect(sizer.size).toBeLessThanOrEqual(2);
  });
});
