import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractEventDefs, parseWorkerConfig } from '@arckive/core';
import { createStore } from '../src/db.js';
import { createMetrics } from '../src/metrics.js';
import { bootstrapIndexer, runLoop, runOnce, type PipelineDeps } from '../src/pipeline.js';
import { HeadSignal } from '../src/signal.js';
import { createRpc } from '../src/rpc.js';
import { PhaseTracker } from '../src/status.js';
import { startAnvil, type AnvilHandle } from './helpers/anvil.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FIXTURE = fileURLToPath(new URL('./fixtures/emitter', import.meta.url));

// The contract's real event: Ping(uint256 indexed n, address who)
// Deliberately wrong ABI: same types (→ same topic0) but no parameter is indexed →
// decodeEventLog expects 64 bytes in data, the log has 32 → DecodeError
const WRONG_ABI = [
  {
    type: 'event', name: 'Ping',
    inputs: [
      { name: 'n', type: 'uint256', indexed: false },
      { name: 'who', type: 'address', indexed: false },
    ],
  },
];

describe('dead-letter + degraded', () => {
  let anvil: AnvilHandle;
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    execSync('forge build', { cwd: FIXTURE, stdio: 'inherit' });
    anvil = await startAnvil();
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
    anvil.stop();
  });

  it('an undecodable log lands in the dead-letter table, the pipeline keeps going', async () => {
    const artifact = JSON.parse(
      readFileSync(`${FIXTURE}/out/Emitter.sol/Emitter.json`, 'utf8'),
    ) as { abi: unknown[]; bytecode: { object: `0x${string}` } };
    const wallet = createWalletClient({
      account: privateKeyToAccount(PK), transport: http(anvil.url),
    }).extend(publicActions);
    const hash = await wallet.deployContract({
      abi: artifact.abi as never, bytecode: artifact.bytecode.object, chain: null,
    });
    const receipt = await wallet.waitForTransactionReceipt({ hash });
    const address = receipt.contractAddress!;
    const tx = await wallet.writeContract({
      address, abi: artifact.abi as never, functionName: 'ping', args: [1n], chain: null,
    });
    await wallet.waitForTransactionReceipt({ hash: tx });

    const dlDefs = extractEventDefs('emitter', address, WRONG_ABI);
    const deps: PipelineDeps = {
      client: createRpc([anvil.url]),
      pool,
      cfg: parseWorkerConfig({
        indexerName: 'dl',
        network: { chainId: 31337, rpc: [anvil.url], finalityTag: 'latest' },
        contracts: [{ name: 'emitter', address, abiPath: 'unused' }],
      }),
      defs: dlDefs,
      schema: 'idx_dl',
      store: createStore('idx_dl', dlDefs, 1_000_000),
      metrics: createMetrics('dl'),
      phase: new PhaseTracker(),
      headSignal: new HeadSignal(),
      log: pino({ level: 'silent' }),
    };
    await bootstrapIndexer(deps);
    while (await runOnce(deps)) { /* catch up */ }

    const dl = await pool.query(`SELECT error FROM idx_dl._dead_letter`);
    expect(dl.rows).toHaveLength(1);
    expect(dl.rows[0].error).toContain('decode');
    const rows = await pool.query(`SELECT count(*)::int AS c FROM idx_dl.emitter_ping`);
    expect(rows.rows[0].c).toBe(0);
    expect(deps.phase.phase).toBe('Live'); // pipeline did not go Degraded
  });

  it('if the RPC drops entirely, runLoop goes Degraded and recovers when it returns', async () => {
    const flaky = await startAnvil();
    const deps: PipelineDeps = {
      client: createRpc([flaky.url]),
      pool,
      cfg: parseWorkerConfig({
        indexerName: 'dg',
        network: { chainId: 31337, rpc: [flaky.url], finalityTag: 'latest' },
        contracts: [{
          name: 'x', address: '0x0000000000000000000000000000000000000001', abiPath: 'unused',
        }],
        polling: { batchBlocks: 10, intervalMs: 50 },
      }),
      defs: [],
      schema: 'idx_dg',
      store: createStore('idx_dg', [], 1_000_000),
      metrics: createMetrics('dg'),
      phase: new PhaseTracker(),
      headSignal: new HeadSignal(),
      log: pino({ level: 'silent' }),
    };
    await bootstrapIndexer(deps);

    const ctrl = new AbortController();
    const loop = runLoop(deps, ctrl.signal);
    await new Promise((r) => setTimeout(r, 500));
    expect(deps.phase.phase).toBe('Live');

    flaky.stop(); // RPC is down
    await new Promise((r) => setTimeout(r, 3000));
    expect(deps.phase.phase).toBe('Degraded');
    expect(deps.phase.lastError).toBeTruthy();

    ctrl.abort();
    await loop;
  });
});
