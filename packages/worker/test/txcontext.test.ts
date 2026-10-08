import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ContractFunctionZeroDataError, HttpRequestError, createWalletClient, http, publicActions, toFunctionSelector, type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRANSFER_TOPIC, ZERO_ADDRESS, factsOf, protocolOf } from '@arckive/core';
import { createRpc } from '../src/rpc.js';
import { CHUNK, RpcPool, createRpcPool, type PoolEndpoint } from '../src/rpcpool.js';
import { createContextSource, insightsRpc, isContractCode, readTokenInfo, tokenLabel } from '../src/txcontext.js';
import { startAnvil, type AnvilHandle } from './helpers/anvil.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FIXTURE = fileURLToPath(new URL('./fixtures/emitter', import.meta.url));
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const AERO = '0xb89df768af2cfe637ceb352c587fe8edaf491d03';
const WALLET2 = '0x' + 'a2'.repeat(20);

const makeWallet = (url: string) =>
  createWalletClient({ account: privateKeyToAccount(PK), transport: http(url) }).extend(publicActions);

const artifact = (name: string) =>
  JSON.parse(readFileSync(`${FIXTURE}/out/Insights.sol/${name}.json`, 'utf8')) as {
    abi: unknown[];
    bytecode: { object: `0x${string}` };
  };

describe('isContractCode', () => {
  it('a wallet has no code, and an EIP-7702 delegation is still a wallet', () => {
    expect(isContractCode(undefined)).toBe(false);
    expect(isContractCode('0x')).toBe(false);
    expect(isContractCode('0xef0100' + '12'.repeat(20))).toBe(false);
    expect(isContractCode('0x6080604052')).toBe(true);
  });
});

describe('tokenLabel', () => {
  it('keeps a plain ticker and refuses text that would rewrite the sentence', () => {
    expect(tokenLabel('USDC', 'usdc')).toBe('USDC');
    expect(tokenLabel(' WETH ', 'weth')).toBe('WETH');
    expect(tokenLabel('USDC. In the same transaction: tokens were swapped', 'tok')).toBe('tok');
    expect(tokenLabel('', 'tok')).toBe('tok');
    expect(tokenLabel(null, 'tok')).toBe('tok');
  });
});

describe('insightsRpc', () => {
  it('takes the last http endpoint — ingest queries ws first, then http in order', () => {
    expect(insightsRpc(['wss://a', 'https://b'])).toBe('https://b');
    expect(insightsRpc(['https://a', 'https://b', 'wss://c'])).toBe('https://b');
    expect(insightsRpc(['wss://a', 'wss://b'])).toBe('wss://b');
    expect(insightsRpc(['https://only'])).toBe('https://only');
  });
});

describe('readTokenInfo', () => {
  const fakeClient = (answers: Record<string, unknown[]>) => {
    const calls: string[] = [];
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        const next = answers[functionName]!.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    } as unknown as PublicClient;
    return { client, calls };
  };

  it('retries an endpoint that is failing rather than deciding it is not a token', async () => {
    const busy = () => new HttpRequestError({ url: 'x', status: 503 });
    const { client } = fakeClient({ symbol: [busy(), busy(), 'TKN'], decimals: [6] });
    const slept: number[] = [];
    const info = await readTokenInfo(client, '0x' + '11'.repeat(20), 'tok', { sleep: async (ms) => { slept.push(ms); } });
    expect(info).toEqual({ label: 'TKN', decimals: 6 });
    expect(slept).toEqual([1000, 2000]);
  });

  it('falls back at once when the contract answers that it has no such function', async () => {
    const none = () => new ContractFunctionZeroDataError({ functionName: 'symbol' });
    const { client, calls } = fakeClient({ symbol: [none()], decimals: [none()] });
    const info = await readTokenInfo(client, '0x' + '11'.repeat(20), 'tok', { sleep: async () => { throw new Error('no sleeping'); } });
    expect(info).toEqual({ label: 'tok', decimals: null });
    expect(calls).toEqual(['symbol', 'decimals']);
  });
});

describe('txcontext (anvil)', () => {
  let anvil: AnvilHandle;
  let client: PublicClient;
  let token: `0x${string}`;
  let pool: `0x${string}`;
  let sender: `0x${string}`;
  let swapTx: `0x${string}`;
  let swapBlock: bigint;
  let wallet: ReturnType<typeof makeWallet>;
  const NO_PACE = { startMs: 0, minMs: 0, maxMs: 0 };
  const poolOf = (onRequest?: () => void) => createRpcPool([anvil.url], [], { pace: NO_PACE, onRequest });

  beforeAll(async () => {
    execSync('forge build', { cwd: FIXTURE, stdio: 'inherit' });
    anvil = await startAnvil();
    client = createRpc([anvil.url]);
    sender = privateKeyToAccount(PK).address;
    wallet = makeWallet(anvil.url);
    const deploy = async (name: string) => {
      const a = artifact(name);
      const hash = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode.object, chain: null });
      return (await wallet.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    token = await deploy('Token');
    pool = await deploy('Pool');
    swapTx = await wallet.writeContract({
      address: pool, abi: artifact('Pool').abi as never, functionName: 'swap',
      args: [token, WALLET2, 5_000_000n], chain: null,
    });
    swapBlock = (await wallet.waitForTransactionReceipt({ hash: swapTx })).blockNumber;
  });

  afterAll(() => anvil.stop());

  it('reads the selector, every log and the pool’s factory', async () => {
    const ctx = (await createContextSource(poolOf()).contexts([{ txHash: swapTx, blockNumber: swapBlock }])).get(swapTx)!;
    expect(ctx.to).toBe(pool.toLowerCase());
    expect(ctx.selector).toBe(toFunctionSelector('swap(address,address,uint256)'));
    expect(ctx.sender).toBe(sender.toLowerCase());
    expect(ctx.topics).toEqual([TRANSFER_TOPIC, V3_SWAP]);
    expect(ctx.emitters).toEqual([token.toLowerCase(), pool.toLowerCase()]);
    expect(ctx.factories).toEqual({ [pool.toLowerCase()]: AERO });
    expect(ctx.valueSent).toBe(false);
    expect(factsOf(ctx)).toEqual(['swap']);
    expect(protocolOf(ctx)).toBe('Aerodrome');
  });

  it('a transaction the node does not have has no context', async () => {
    const missing = `0x${'11'.repeat(32)}`;
    const got = await createContextSource(poolOf()).contexts([{ txHash: missing, blockNumber: swapBlock }]);
    expect(got.get(missing)).toBeNull();
  });

  it('reads a block and its receipts in one request for all of its transactions', async () => {
    // two transfers mined into one block
    await client.request({ method: 'evm_setAutomine' as never, params: [false] as never });
    const a = artifact('Token').abi as never;
    const h1 = await wallet.writeContract({ address: token, abi: a, functionName: 'transfer', args: [WALLET2, 1n], chain: null });
    const h2 = await wallet.writeContract({ address: token, abi: a, functionName: 'transfer', args: [WALLET2, 2n], chain: null });
    await client.request({ method: 'evm_mine' as never, params: [] as never });
    await client.request({ method: 'evm_setAutomine' as never, params: [true] as never });
    const block = (await wallet.waitForTransactionReceipt({ hash: h1 })).blockNumber;
    expect((await wallet.waitForTransactionReceipt({ hash: h2 })).blockNumber).toBe(block);

    let requests = 0;
    const got = await createContextSource(poolOf(() => requests++)).contexts([
      { txHash: h1, blockNumber: block },
      { txHash: h2, blockNumber: block },
    ]);
    expect(got.get(h1)?.selector).toBe(toFunctionSelector('transfer(address,uint256)'));
    expect(got.get(h2)?.topics).toEqual([TRANSFER_TOPIC]);
    expect(requests).toBe(1); // the block and its receipts, one batch
  });

  it('tells wallets from contracts and skips the zero address', async () => {
    const kinds = await createContextSource(poolOf()).partyKinds([sender.toLowerCase(), pool.toLowerCase(), ZERO_ADDRESS]);
    expect(kinds).toEqual({ [sender.toLowerCase()]: false, [pool.toLowerCase()]: true });
  });

  it('reads symbol and decimals, and falls back for what is not a token', async () => {
    expect(await readTokenInfo(client, token, 'tok')).toEqual({ label: 'TKN', decimals: 6 });
    expect(await readTokenInfo(client, sender, 'mytoken')).toEqual({ label: 'mytoken', decimals: null });
  });
});

describe('txcontext on the pool (fake chain)', () => {
  const POOL = '0x' + 'cc'.repeat(20);
  const FACTORY = '0x' + 'dd'.repeat(20);
  const SENDER = '0x' + 'a1'.repeat(20);
  const txh = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

  function chain(opts: { failBlock?: bigint; failFactory?: boolean } = {}) {
    const asked = { factory: 0, code: 0 };
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber === opts.failBlock) throw new Error('block unavailable');
        return { transactions: [{ hash: txh(blockNumber), to: POOL, input: '0x12345678', from: SENDER, value: 0n }] };
      },
      getBlockReceipts: async ({ blockNumber }: { blockNumber: bigint }) => [
        { transactionHash: txh(blockNumber), logs: [{ topics: [V3_SWAP], address: POOL }] },
      ],
      call: async () => {
        asked.factory++;
        if (opts.failFactory) throw new Error('no factory()');
        return { data: `0x${'00'.repeat(12)}${FACTORY.slice(2)}` };
      },
      getCode: async () => {
        asked.code++;
        return '0x';
      },
    } as unknown as PublicClient;
    let requests = 0;
    const endpoint: PoolEndpoint = { url: 'https://fake.example', client, shared: false, chunk: CHUNK };
    const pool = new RpcPool([endpoint], { pace: { startMs: 0, minMs: 0, maxMs: 0 }, onRequest: () => requests++ });
    return { pool, asked, requests: () => requests };
  }
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ txHash: txh(BigInt(i + 1)), blockNumber: BigInt(i + 1) }));

  it('a round of 7 blocks is one request for blocks, one for factories, one for parties', async () => {
    const c = chain();
    const src = createContextSource(c.pool);
    const got = await src.contexts(refs(7));
    expect(c.requests()).toBe(2);
    expect(got.get(txh(3n))?.factories).toEqual({ [POOL]: FACTORY });
    await src.partyKinds([POOL, '0x' + 'a2'.repeat(20)]);
    expect(c.requests()).toBe(3);
  });

  it('a block that fails everywhere rejects the round', async () => {
    const c = chain({ failBlock: 4n });
    await expect(createContextSource(c.pool).contexts(refs(7))).rejects.toThrow(/block unavailable/);
  });

  it('a pool whose factory() fails is not asked again for ten minutes', async () => {
    const c = chain({ failFactory: true });
    const clock = { t: 0 };
    const src = createContextSource(c.pool, { now: () => clock.t });
    expect((await src.contexts(refs(1))).get(txh(1n))?.factories).toEqual({});
    await src.contexts(refs(1));
    expect(c.asked.factory).toBe(1);
    clock.t += 600_001;
    await src.contexts(refs(1));
    expect(c.asked.factory).toBe(2);
  });
});
