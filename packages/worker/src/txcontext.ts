import {
  AbiDecodingZeroDataError, BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError,
  createPublicClient, erc20Abi, http, webSocket, type PublicClient,
} from 'viem';
import { FACTORY_CALL, POOL_TOPICS, ZERO_ADDRESS, type TokenInfo, type TxContext } from '@arckive/core';
import { Pacer, type PaceLimits } from './pacer.js';

// What the insight loop needs to know about a transaction beyond its own
// event: the function called, every event logged, who deployed the pools it
// touched, and whether each transfer party is a wallet or a contract. Ported
// from radar/radar/arc.py (_items), which reads per transaction; this reads
// per block — one block and its receipts — because on Arc mainnet a block
// with USDC events carried 3.1 such transactions on average, so per block is
// a third of the calls on an RPC budget shared with ingest.

// Every RPC call made for insights goes through one pacer, one at a time:
// four a second to start, as fast as twenty a second on an endpoint that
// takes it, as slow as one per 8 s on one that does not (see pacer.ts).
export const INSIGHTS_RPC_PACE: PaceLimits = { startMs: 250, minMs: 50, maxMs: 8000 };
const CACHE_MAX = 50_000;
// A pool that cannot answer factory() fails the same way every time; asked
// again only after this long.
const FACTORY_RETRY_MS = 600_000;

// An EIP-7702 account carries code too — 0xef0100 and the address it
// delegates to, 23 bytes — but it is still somebody's wallet with a key. On
// mainnet 268 of 663 addresses with code were these; calling them contracts
// told the model a payment between two people went contract to contract.
export function isContractCode(code: string | undefined): boolean {
  if (!code || code === '0x' || code === '0x0') return false;
  return !(code.toLowerCase().startsWith('0xef0100') && code.length === 2 + 2 * 23);
}

// Ingest queries ws endpoints first, then http, in config order (rpc.ts,
// rank: false), so the first of them carries its load. Insights take the last
// http endpoint (the last ws one if there is no http): given more than one,
// they spend another endpoint's rate limit than the one ingest depends on.
export function insightsRpc(rpcs: readonly string[]): string {
  const httpUrls = rpcs.filter((u) => /^https?:\/\//i.test(u));
  const pool = httpUrls.length ? httpUrls : rpcs;
  return pool[pool.length - 1]!;
}

// One endpoint, no fallback, no transport retries: a rate-limit answer has to
// reach the pacer (pacer.ts) to slow it down. Behind viem's fallback it would
// be retried on the next endpoint — ingest's — and count as a success.
export function createInsightsRpc(rpcs: readonly string[]): PublicClient {
  const url = insightsRpc(rpcs);
  const transport = /^wss?:\/\//i.test(url)
    ? webSocket(url, { timeout: 10_000, retryCount: 0 })
    : http(url, { timeout: 10_000, retryCount: 0 });
  return createPublicClient({ transport });
}

// symbol() is text anyone deploying a token chooses, and it lands in the
// sentence the model reads. Only a short plain ticker is used as one.
export function tokenLabel(symbol: string | null, fallback: string): string {
  const s = symbol?.trim() ?? '';
  return /^[A-Za-z0-9$._-]{1,16}$/.test(s) ? s : fallback;
}

// The contract answered, and the answer is no: it reverted or has no such
// function. Anything else — a timeout, a 503, a rate limit — says nothing
// about the token.
function isDefiniteNo(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof AbiDecodingZeroDataError,
    ) !== null
  );
}

export interface TokenReadOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Read once at startup and used for the life of the process, so a failing
// endpoint is retried (1 s, 2 s, 4 s, 8 s) rather than taken to mean "not a
// token" — which would turn "USDC … 1 to 100 USDC" into "usdc … a nonzero
// amount of usdc" in every sentence until the next restart.
export async function readTokenInfo(
  client: PublicClient, address: string, fallback: string, opts: TokenReadOptions = {},
): Promise<TokenInfo> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const at = address as `0x${string}`;
  async function read<F extends 'symbol' | 'decimals'>(functionName: F) {
    for (let i = 0; ; i++) {
      try {
        return await client.readContract({ address: at, abi: erc20Abi, functionName });
      } catch (err) {
        if (isDefiniteNo(err) || i + 1 >= attempts) return null;
        await sleep(1000 * 2 ** i);
      }
    }
  }
  const symbol = await read('symbol');
  const decimals = await read('decimals');
  return { label: tokenLabel(typeof symbol === 'string' ? symbol : null, fallback), decimals: typeof decimals === 'number' ? decimals : null };
}

export interface TxRef {
  txHash: string;
  blockNumber: bigint;
}

export interface ContextSource {
  // keyed by txHash; null for a transaction its block does not hold. An RPC
  // failure rejects.
  contexts(txs: readonly TxRef[]): Promise<Map<string, TxContext | null>>;
  // address -> is a contract; the zero address is never asked about.
  partyKinds(addresses: readonly string[]): Promise<Record<string, boolean>>;
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

export interface ContextSourceOptions {
  now?: () => number;
  pacer?: Pick<Pacer, 'run'>;
}

export function createContextSource(client: PublicClient, opts: ContextSourceOptions = {}): ContextSource {
  const now = opts.now ?? Date.now;
  const pacer = opts.pacer ?? new Pacer(INSIGHTS_RPC_PACE);
  const codes = new Lru<boolean>(CACHE_MAX);
  const factories = new Lru<string>(CACHE_MAX);
  const unreadable = new Map<string, number>(); // pool -> when factory() may be asked again

  // The wanted transactions of one block, from the block and its receipts.
  async function readBlock(blockNumber: bigint, wanted: ReadonlySet<string>, out: Map<string, TxContext>): Promise<void> {
    const block = await pacer.run(() => client.getBlock({ blockNumber, includeTransactions: true }));
    const receipts = await pacer.run(() => client.getBlockReceipts({ blockNumber }));
    const byHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));
    for (const tx of block.transactions) {
      const hash = tx.hash.toLowerCase();
      const receipt = byHash.get(hash);
      if (!wanted.has(hash) || !receipt) continue;
      const logs = receipt.logs.filter((l) => l.topics.length > 0);
      const input = tx.input ?? '0x';
      out.set(hash, {
        to: tx.to ? tx.to.toLowerCase() : null,
        selector: input.length >= 10 ? input.slice(0, 10).toLowerCase() : '0x',
        topics: logs.map((l) => l.topics[0]!.toLowerCase()),
        sender: tx.from.toLowerCase(),
        emitters: logs.map((l) => l.address.toLowerCase()),
        factories: {},
        valueSent: tx.value > 0n,
      });
    }
  }

  // Which exchange a swap happened on is a fact about the pool, not about the
  // event it logs: Uniswap v3's Swap is logged, byte for byte, by every fork.
  async function askFactory(pool: string): Promise<void> {
    try {
      const { data } = await pacer.run(() => client.call({ to: pool as `0x${string}`, data: FACTORY_CALL }));
      if (data && data.length >= 42) {
        factories.set(pool, `0x${data.slice(-40).toLowerCase()}`);
        unreadable.delete(pool);
        return;
      }
    } catch {
      // a contract that logs a pool event but has no factory() — retried later
    }
    unreadable.set(pool, now() + FACTORY_RETRY_MS);
  }

  return {
    async contexts(txs) {
      const byBlock = new Map<bigint, Set<string>>();
      for (const t of txs) {
        const set = byBlock.get(t.blockNumber) ?? new Set<string>();
        set.add(t.txHash.toLowerCase());
        byBlock.set(t.blockNumber, set);
      }
      const read = new Map<string, TxContext>();
      for (const [blockNumber, wanted] of byBlock) await readBlock(blockNumber, wanted, read);

      const poolsOf = new Map<string, string[]>();
      for (const [hash, c] of read) {
        poolsOf.set(hash, [...new Set(c.emitters.filter((e, i) => e && POOL_TOPICS.has(c.topics[i]!)))]);
      }
      const clock = now();
      const ask = [...new Set([...poolsOf.values()].flat())].filter(
        (p) => factories.get(p) === undefined && (unreadable.get(p) ?? 0) <= clock,
      );
      for (const p of ask) await askFactory(p);
      if (unreadable.size > 10_000) {
        for (const [p, until] of unreadable) if (until <= clock) unreadable.delete(p);
      }
      const out = new Map<string, TxContext | null>();
      for (const t of txs) {
        const c = read.get(t.txHash.toLowerCase()) ?? null;
        if (c) {
          for (const p of poolsOf.get(t.txHash.toLowerCase()) ?? []) {
            const f = factories.get(p);
            if (f) c.factories[p] = f;
          }
        }
        out.set(t.txHash, c);
      }
      return out;
    },

    async partyKinds(addresses) {
      const wanted = [...new Set(addresses)].filter((a) => a !== ZERO_ADDRESS);
      for (const a of wanted.filter((x) => codes.get(x) === undefined)) {
        const code = await pacer.run(() => client.getCode({ address: a as `0x${string}` }));
        codes.set(a, isContractCode(code));
      }
      const out: Record<string, boolean> = {};
      for (const a of wanted) {
        const v = codes.get(a);
        if (v !== undefined) out[a] = v;
      }
      return out;
    },
  };
}
