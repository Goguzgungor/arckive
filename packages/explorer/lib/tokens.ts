import type pg from 'pg';
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, RpcRequestError, TimeoutError,
  createPublicClient, erc20Abi, http,
} from 'viem';
import { hexToBytes, bytesToHex } from './db.js';
import { usdcFace } from './usdc.js';

export interface TokenMeta {
  symbol: string | null;
  decimals: number | null;
}

export type ReadResult = TokenMeta | 'unavailable';

export interface TokenReader {
  read(address: string): Promise<ReadResult>;
}

// USDC in either face (address(0), the native currency with 18 decimals, and
// the ERC-20 at 0x3600…0000 with 6) is answered without an RPC call.
const known = (a: string): TokenMeta | null => {
  const f = usdcFace(a);
  return f ? { symbol: f.symbol, decimals: f.decimals } : null;
};

// Only a revert or an empty answer means "not a token"; a transport failure
// (a rate limit, a timeout) is asked again on a later page view, never stored.
export function classifyReadError(err: unknown): 'none' | 'unavailable' {
  if (!(err instanceof BaseError)) return 'none';
  if (err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) return 'none';
  if (err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError)) return 'unavailable';
  return 'none';
}

// A token names itself: printable ASCII only (no control or bidi characters), short.
export function sanitizeSymbol(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 16);
  return clean || null;
}

async function attempt<T>(f: () => Promise<T>): Promise<T | null | 'unavailable'> {
  try {
    return await f();
  } catch (err) {
    return classifyReadError(err) === 'unavailable' ? 'unavailable' : null;
  }
}

// One try, 2 s: a page waits on this read, and a retry would double the wait
// on an RPC that is already failing.
export function rpcTokenReader(rpcUrl: string): TokenReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 2000, retryCount: 0 }) });
  return {
    async read(a) {
      const address = a as `0x${string}`;
      const [symbol, decimals] = await Promise.all([
        attempt(() => client.readContract({ address, abi: erc20Abi, functionName: 'symbol' })),
        attempt(() => client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })),
      ]);
      if (symbol === 'unavailable' || decimals === 'unavailable') return 'unavailable';
      return { symbol: sanitizeSymbol(symbol), decimals: typeof decimals === 'number' && decimals <= 77 ? decimals : null };
    },
  };
}

// After an RPC read could not be answered, no reads for this long.
const OUTAGE_MS = 60_000;

// Pool currencies' symbol and decimals, read over ARC_RPC the first time a
// page needs them and kept in explorer.tokens. An unanswered read (a rate
// limit, a timeout) is remembered in memory for a minute: during an outage
// every page view would otherwise wait on the RPC again, and Arc's public
// RPC counts each call against its per-minute quota.
export class Tokens {
  #downUntil = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly reader: TokenReader,
    private readonly now: () => number = Date.now,
  ) {}

  async get(addresses: string[]): Promise<Record<string, TokenMeta>> {
    const out: Record<string, TokenMeta> = {};
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => {
      const meta = known(a);
      if (meta) out[a] = meta;
      return !meta;
    });
    if (!wanted.length) return out;
    const stored = await this.pool.query<{ address: Buffer; symbol: string | null; decimals: number | null }>(
      'SELECT address, symbol, decimals FROM explorer.tokens WHERE address = ANY($1::bytea[])',
      [wanted.map(hexToBytes)],
    );
    for (const r of stored.rows) out[bytesToHex(r.address)] = { symbol: r.symbol, decimals: r.decimals };
    await Promise.all(
      wanted.filter((a) => !out[a]).map(async (a) => {
        // remembered, not extended: a busy page must not keep the outage open
        if (this.now() < this.#downUntil) {
          out[a] = { symbol: null, decimals: null };
          return;
        }
        const meta = await this.reader.read(a);
        if (meta === 'unavailable') {
          this.#downUntil = this.now() + OUTAGE_MS;
          out[a] = { symbol: null, decimals: null };
          return;
        }
        out[a] = meta;
        await this.pool.query(
          'INSERT INTO explorer.tokens (address, symbol, decimals) VALUES ($1, $2, $3) ON CONFLICT (address) DO NOTHING',
          [hexToBytes(a), meta.symbol, meta.decimals],
        );
      }),
    );
    return out;
  }
}
