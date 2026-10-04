import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, publicActions, toFunctionSelector, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRANSFER_TOPIC, ZERO_ADDRESS, factsOf, protocolOf } from '@arckive/core';
import { createRpc } from '../src/rpc.js';
import { createContextSource, isContractCode, readTokenInfo, tokenLabel } from '../src/txcontext.js';
import { startAnvil, type AnvilHandle } from './helpers/anvil.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FIXTURE = fileURLToPath(new URL('./fixtures/emitter', import.meta.url));
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const AERO = '0xb89df768af2cfe637ceb352c587fe8edaf491d03';
const WALLET2 = '0x' + 'a2'.repeat(20);

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

describe('txcontext (anvil)', () => {
  let anvil: AnvilHandle;
  let client: PublicClient;
  let token: `0x${string}`;
  let pool: `0x${string}`;
  let sender: `0x${string}`;
  let swapTx: `0x${string}`;

  beforeAll(async () => {
    execSync('forge build', { cwd: FIXTURE, stdio: 'inherit' });
    anvil = await startAnvil();
    client = createRpc([anvil.url]);
    const account = privateKeyToAccount(PK);
    sender = account.address;
    const wallet = createWalletClient({ account, transport: http(anvil.url) }).extend(publicActions);
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
    await wallet.waitForTransactionReceipt({ hash: swapTx });
  });

  afterAll(() => anvil.stop());

  it('reads the selector, every log and the pool’s factory', async () => {
    const ctx = (await createContextSource(client).contexts([swapTx])).get(swapTx)!;
    expect(ctx.to).toBe(pool.toLowerCase());
    expect(ctx.selector).toBe(toFunctionSelector('swap(address,address,uint256)'));
    expect(ctx.sender).toBe(sender.toLowerCase());
    expect(ctx.topics).toEqual([TRANSFER_TOPIC, V3_SWAP]);
    expect(ctx.emitters).toEqual([token.toLowerCase(), pool.toLowerCase()]);
    expect(ctx.factories).toEqual({ [pool.toLowerCase()]: AERO });
    expect(factsOf(ctx)).toEqual(['swap']);
    expect(protocolOf(ctx)).toBe('Aerodrome');
  });

  it('a transaction the node does not have has no context', async () => {
    const missing = `0x${'11'.repeat(32)}`;
    expect((await createContextSource(client).contexts([missing])).get(missing)).toBeNull();
  });

  it('tells wallets from contracts and skips the zero address', async () => {
    const kinds = await createContextSource(client).partyKinds([sender.toLowerCase(), pool.toLowerCase(), ZERO_ADDRESS]);
    expect(kinds).toEqual({ [sender.toLowerCase()]: false, [pool.toLowerCase()]: true });
  });

  it('reads symbol and decimals, and falls back for what is not a token', async () => {
    expect(await readTokenInfo(client, token, 'tok')).toEqual({ label: 'TKN', decimals: 6 });
    expect(await readTokenInfo(client, sender, 'mytoken')).toEqual({ label: 'mytoken', decimals: null });
  });
});
