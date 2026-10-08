import type pg from 'pg';
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, RpcRequestError, TimeoutError,
  createPublicClient, erc20Abi, http,
} from 'viem';
import { hexToBytes, bytesToHex } from './db.js';
import { ZERO_ADDRESS } from './format.js';

export interface TokenMeta {
  symbol: string | null;
  decimals: number | null;
}

export type ReadResult = TokenMeta | 'unavailable';

export interface TokenReader {
  read(address: string): Promise<ReadResult>;
}

// In a v4 pool, address(0) is the chain's native currency: on Arc, USDC with 18 decimals.
const NATIVE: TokenMeta = { symbol: 'USDC', decimals: 18 };

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

export function rpcTokenReader(rpcUrl: string): TokenReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 4000, retryCount: 1 }) });
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

// Pool currencies' symbol and decimals, read over ARC_RPC the first time a
// page needs them and kept in explorer.tokens.
export class Tokens {
  constructor(
    private readonly pool: pg.Pool,
    private readonly reader: TokenReader,
  ) {}

  async get(addresses: string[]): Promise<Record<string, TokenMeta>> {
    const out: Record<string, TokenMeta> = {};
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => {
      if (a === ZERO_ADDRESS) out[a] = NATIVE;
      return a !== ZERO_ADDRESS;
    });
    if (!wanted.length) return out;
    const known = await this.pool.query<{ address: Buffer; symbol: string | null; decimals: number | null }>(
      'SELECT address, symbol, decimals FROM explorer.tokens WHERE address = ANY($1::bytea[])',
      [wanted.map(hexToBytes)],
    );
    for (const r of known.rows) out[bytesToHex(r.address)] = { symbol: r.symbol, decimals: r.decimals };
    await Promise.all(
      wanted.filter((a) => !out[a]).map(async (a) => {
        const meta = await this.reader.read(a);
        if (meta === 'unavailable') {
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
