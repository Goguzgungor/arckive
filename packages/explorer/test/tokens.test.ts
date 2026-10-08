import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, erc20Abi,
} from 'viem';
import { startDb, type TestDb } from './fixture/db.ts';
import { SWAP_TOKEN, ZERO } from './fixture/rows.ts';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';
import { Tokens, classifyReadError, sanitizeSymbol, type ReadResult, type TokenReader } from '../lib/tokens.js';

function fakeReader(answers: Record<string, ReadResult>): TokenReader & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async read(a) { calls.push(a); return answers[a] ?? { symbol: null, decimals: null }; } };
}

describe('classifyReadError', () => {
  const wrap = (cause: Error) => new ContractFunctionExecutionError(cause as never, { abi: erc20Abi, functionName: 'symbol' });
  it('reads a revert or empty answer as "not a token"', () => {
    expect(classifyReadError(wrap(new ContractFunctionZeroDataError({ functionName: 'symbol' })))).toBe('none');
    expect(classifyReadError(wrap(new ContractFunctionRevertedError({ abi: erc20Abi, functionName: 'symbol', message: 'execution reverted' })))).toBe('none');
  });
  it('reads a transport failure as "ask again later"', () => {
    expect(classifyReadError(wrap(new HttpRequestError({ url: 'https://rpc.example', status: 429 })))).toBe('unavailable');
  });
});

describe('sanitizeSymbol', () => {
  it('keeps printable ASCII, at most 16 characters', () => {
    expect(sanitizeSymbol('USDC')).toBe('USDC');
    expect(sanitizeSymbol('A\u0000B‮C')).toBe('ABC');
    expect(sanitizeSymbol('x'.repeat(40))).toBe('x'.repeat(16));
    expect(sanitizeSymbol('  ')).toBeNull();
    expect(sanitizeSymbol(42)).toBeNull();
  });
});

describe('Tokens', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb({ insights: false });
    await ensureExplorerSchema(db.explorer);
  });
  afterAll(async () => { await db?.stop(); });

  it('never reads address(0): in a v4 pool it is native USDC', async () => {
    const reader = fakeReader({});
    expect(await new Tokens(db.explorer, reader).get([ZERO])).toEqual({ [ZERO]: { symbol: 'USDC', decimals: 18 } });
    expect(reader.calls).toEqual([]);
  });

  it('answers the ERC-20 face of USDC (0x3600…0000) without a call, with 6 decimals', async () => {
    const reader = fakeReader({});
    const erc20 = '0x3600000000000000000000000000000000000000';
    expect(await new Tokens(db.explorer, reader).get([erc20.toUpperCase().replace('0X', '0x')])).toEqual({ [erc20]: { symbol: 'USDC', decimals: 6 } });
    expect(reader.calls).toEqual([]);
  });

  it('reads a token once and keeps it', async () => {
    const reader = fakeReader({ [SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } });
    const tokens = new Tokens(db.explorer, reader);
    expect(await tokens.get([SWAP_TOKEN, SWAP_TOKEN])).toEqual({ [SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } });
    expect(await new Tokens(db.explorer, fakeReader({})).get([SWAP_TOKEN])).toEqual({ [SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } });
    expect(reader.calls).toEqual([SWAP_TOKEN]);
  });

  it('stores a token that answers neither as nulls', async () => {
    const odd = `0x${'7'.repeat(40)}`;
    await new Tokens(db.explorer, fakeReader({ [odd]: { symbol: null, decimals: null } })).get([odd]);
    const r = await db.explorer.query('SELECT symbol, decimals FROM explorer.tokens WHERE address = $1', [Buffer.from(odd.slice(2), 'hex')]);
    expect(r.rows).toEqual([{ symbol: null, decimals: null }]);
  });

  it('remembers an RPC outage for a minute instead of asking on every page view', async () => {
    const down = `0x${'9'.repeat(40)}`;
    const other = `0x${'a'.repeat(40)}`;
    let now = 1_000_000;
    const reader = fakeReader({ [down]: 'unavailable', [other]: 'unavailable' });
    const tokens = new Tokens(db.explorer, reader, () => now);
    expect(await tokens.get([down])).toEqual({ [down]: { symbol: null, decimals: null } });
    now += 59_000;
    expect(await tokens.get([down, other])).toEqual({ [down]: { symbol: null, decimals: null }, [other]: { symbol: null, decimals: null } });
    expect(reader.calls).toEqual([down]);
    now += 1_001;
    await tokens.get([down]);
    expect(reader.calls).toEqual([down, down]);
  });

  it('does not store a read the RPC could not answer', async () => {
    const down = `0x${'8'.repeat(40)}`;
    expect(await new Tokens(db.explorer, fakeReader({ [down]: 'unavailable' })).get([down])).toEqual({ [down]: { symbol: null, decimals: null } });
    const r = await db.explorer.query('SELECT 1 FROM explorer.tokens WHERE address = $1', [Buffer.from(down.slice(2), 'hex')]);
    expect(r.rowCount).toBe(0);
  });
});
