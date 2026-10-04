import {
  TransactionNotFoundError, TransactionReceiptNotFoundError, erc20Abi, type PublicClient,
} from 'viem';
import { FACTORY_CALL, POOL_TOPICS, ZERO_ADDRESS, type TokenInfo, type TxContext } from '@arckive/core';

// What the insight loop needs to know about a transaction beyond its own
// event: the function called, every event logged, who deployed the pools it
// touched, and whether each transfer party is a wallet or a contract. Ported
// from radar/radar/arc.py (_items).

const CONC = 8;
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

// symbol() is text anyone deploying a token chooses, and it lands in the
// sentence the model reads. Only a short plain ticker is used as one.
export function tokenLabel(symbol: string | null, fallback: string): string {
  const s = symbol?.trim() ?? '';
  return /^[A-Za-z0-9$._-]{1,16}$/.test(s) ? s : fallback;
}

export async function readTokenInfo(client: PublicClient, address: string, fallback: string): Promise<TokenInfo> {
  const at = address as `0x${string}`;
  const [symbol, decimals] = await Promise.allSettled([
    client.readContract({ address: at, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: at, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return {
    label: tokenLabel(symbol.status === 'fulfilled' ? symbol.value : null, fallback),
    decimals: decimals.status === 'fulfilled' ? decimals.value : null,
  };
}

export interface ContextSource {
  // null for a transaction the node does not have; an RPC failure rejects.
  contexts(txHashes: readonly string[]): Promise<Map<string, TxContext | null>>;
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

async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONC) out.push(...(await Promise.all(items.slice(i, i + CONC).map(fn))));
  return out;
}

export function createContextSource(client: PublicClient, now: () => number = Date.now): ContextSource {
  const codes = new Lru<boolean>(CACHE_MAX);
  const factories = new Lru<string>(CACHE_MAX);
  const unreadable = new Map<string, number>(); // pool -> when factory() may be asked again

  async function read(hash: string): Promise<TxContext | null> {
    const h = hash as `0x${string}`;
    let tx, receipt;
    try {
      [tx, receipt] = await Promise.all([client.getTransaction({ hash: h }), client.getTransactionReceipt({ hash: h })]);
    } catch (err) {
      if (err instanceof TransactionNotFoundError || err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
    const logs = receipt.logs.filter((l) => l.topics.length > 0);
    const input = tx.input ?? '0x';
    return {
      to: tx.to ? tx.to.toLowerCase() : null,
      selector: input.length >= 10 ? input.slice(0, 10).toLowerCase() : '0x',
      topics: logs.map((l) => l.topics[0]!.toLowerCase()),
      sender: tx.from.toLowerCase(),
      emitters: logs.map((l) => l.address.toLowerCase()),
      factories: {},
    };
  }

  // Which exchange a swap happened on is a fact about the pool, not about the
  // event it logs: Uniswap v3's Swap is logged, byte for byte, by every fork.
  async function askFactory(pool: string): Promise<void> {
    try {
      const { data } = await client.call({ to: pool as `0x${string}`, data: FACTORY_CALL });
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
    async contexts(txHashes) {
      const hashes = [...new Set(txHashes)];
      const ctxs = await mapLimit(hashes, read);
      const poolsOf = ctxs.map((c) =>
        c ? [...new Set(c.emitters.filter((e, i) => e && POOL_TOPICS.has(c.topics[i]!)))] : [],
      );
      const clock = now();
      const ask = [...new Set(poolsOf.flat())].filter(
        (p) => factories.get(p) === undefined && (unreadable.get(p) ?? 0) <= clock,
      );
      await mapLimit(ask, askFactory);
      if (unreadable.size > 10_000) {
        for (const [p, until] of unreadable) if (until <= clock) unreadable.delete(p);
      }
      const out = new Map<string, TxContext | null>();
      hashes.forEach((h, i) => {
        const c = ctxs[i] ?? null;
        if (c) {
          for (const p of poolsOf[i]!) {
            const f = factories.get(p);
            if (f) c.factories[p] = f;
          }
        }
        out.set(h, c);
      });
      return out;
    },

    async partyKinds(addresses) {
      const wanted = [...new Set(addresses)].filter((a) => a !== ZERO_ADDRESS);
      const unknown = wanted.filter((a) => codes.get(a) === undefined);
      const got = await mapLimit(unknown, (a) => client.getCode({ address: a as `0x${string}` }));
      unknown.forEach((a, i) => codes.set(a, isContractCode(got[i])));
      const out: Record<string, boolean> = {};
      for (const a of wanted) {
        const v = codes.get(a);
        if (v !== undefined) out[a] = v;
      }
      return out;
    },
  };
}
