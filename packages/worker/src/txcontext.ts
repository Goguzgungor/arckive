import {
  AbiDecodingZeroDataError, BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError,
  erc20Abi, type PublicClient,
} from 'viem';
import { FACTORY_CALL, POOL_TOPICS, ZERO_ADDRESS, type TokenInfo, type TxContext } from '@arckive/core';
import type { RpcPool } from './rpcpool.js';

// What the insight loop needs to know about a transaction beyond its own
// event: the function called, every event logged, who deployed the pools it
// touched, and whether each transfer party is a wallet or a contract. Ported
// from radar/radar/arc.py (_items), which reads per transaction; this reads
// per block — one block and its receipts — because on Arc mainnet a block
// with USDC events carried 3.1 such transactions on average, so per block is
// a third of the calls; the pool (rpcpool.ts) sends a round's blocks ten to a request.

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
// `spec.insights.rpc` replaces this choice with a list of its own.
export function insightsRpc(rpcs: readonly string[]): string {
  const httpUrls = rpcs.filter((u) => /^https?:\/\//i.test(u));
  const pool = httpUrls.length ? httpUrls : rpcs;
  return pool[pool.length - 1]!;
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
}

const fullBlock = (c: PublicClient, blockNumber: bigint) => c.getBlock({ blockNumber, includeTransactions: true });
const blockReceipts = (c: PublicClient, blockNumber: bigint) => c.getBlockReceipts({ blockNumber });
type FullBlock = Awaited<ReturnType<typeof fullBlock>>;
type Receipts = Awaited<ReturnType<typeof blockReceipts>>;

// One round's reads go through the pool in three batches at most: every
// block with its receipts, then the new pools' factory(), then the new
// parties' code.
export function createContextSource(pool: Pick<RpcPool, 'all'>, opts: ContextSourceOptions = {}): ContextSource {
  const now = opts.now ?? Date.now;
  const codes = new Lru<boolean>(CACHE_MAX);
  const factories = new Lru<string>(CACHE_MAX);
  const unreadable = new Map<string, number>(); // pool -> when factory() may be asked again

  // The wanted transactions of one block, from the block and its receipts.
  function collect(block: FullBlock, receipts: Receipts, wanted: ReadonlySet<string>, out: Map<string, TxContext>): void {
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

  return {
    async contexts(txs) {
      const byBlock = new Map<bigint, Set<string>>();
      for (const t of txs) {
        const set = byBlock.get(t.blockNumber) ?? new Set<string>();
        set.add(t.txHash.toLowerCase());
        byBlock.set(t.blockNumber, set);
      }
      const blocks = [...byBlock.keys()];
      const reads = await pool.all<FullBlock | Receipts>(
        blocks.flatMap((b) => [(c: PublicClient) => fullBlock(c, b), (c: PublicClient) => blockReceipts(c, b)]),
      );
      const read = new Map<string, TxContext>();
      blocks.forEach((b, k) => {
        const block = reads[2 * k]!;
        const receipts = reads[2 * k + 1]!;
        // every endpoint failed this block: the round fails and is retried
        if (block.status === 'rejected') throw block.reason;
        if (receipts.status === 'rejected') throw receipts.reason;
        collect(block.value as FullBlock, receipts.value as Receipts, byBlock.get(b)!, read);
      });

      const poolsOf = new Map<string, string[]>();
      for (const [hash, c] of read) {
        poolsOf.set(hash, [...new Set(c.emitters.filter((e, i) => e && POOL_TOPICS.has(c.topics[i]!)))]);
      }
      const clock = now();
      const ask = [...new Set([...poolsOf.values()].flat())].filter(
        (p) => factories.get(p) === undefined && (unreadable.get(p) ?? 0) <= clock,
      );
      // Which exchange a swap happened on is a fact about the pool, not about
      // the event it logs: Uniswap v3's Swap is logged, byte for byte, by every fork.
      const answers = await pool.all(ask.map((p) => (c: PublicClient) => c.call({ to: p as `0x${string}`, data: FACTORY_CALL })));
      ask.forEach((p, k) => {
        const a = answers[k]!;
        const data = a.status === 'fulfilled' ? a.value.data : undefined;
        if (data && data.length >= 42) {
          factories.set(p, `0x${data.slice(-40).toLowerCase()}`);
          unreadable.delete(p);
        } else {
          // a contract that logs a pool event but has no factory() — retried later
          unreadable.set(p, clock + FACTORY_RETRY_MS);
        }
      });
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
      const unknown = wanted.filter((x) => codes.get(x) === undefined);
      const got = await pool.all(unknown.map((a) => (c: PublicClient) => c.getCode({ address: a as `0x${string}` })));
      unknown.forEach((a, k) => {
        const r = got[k]!;
        if (r.status === 'rejected') throw r.reason;
        codes.set(a, isContractCode(r.value));
      });
      const out: Record<string, boolean> = {};
      for (const a of wanted) {
        const v = codes.get(a);
        if (v !== undefined) out[a] = v;
      }
      return out;
    },
  };
}
