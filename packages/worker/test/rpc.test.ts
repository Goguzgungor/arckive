import { ResponseBodyTooLargeError } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  blockTimesFromLogs, createRpc, fetchLogs, filterHealthyRpcs, getBlockTimes, getFinalizedBlockNumber, isRangeCapError, splitRpcUrls,
} from '../src/rpc.js';
import { startAnvil, type AnvilHandle } from './helpers/anvil.js';

describe('rpc', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvil(); // default chainId 31337
  });
  afterAll(() => anvil.stop());

  it('filterHealthyRpcs: matching endpoints stay, mismatched/dead ones are dropped', async () => {
    const healthy = await filterHealthyRpcs(
      ['http://127.0.0.1:1', anvil.url], 31337,
    );
    expect(healthy).toEqual([anvil.url]);
    expect(await filterHealthyRpcs([anvil.url], 5042002)).toEqual([]);
  });

  it('fallback: dead endpoint + healthy endpoint still works', async () => {
    const client = createRpc(['http://127.0.0.1:1', anvil.url]);
    const n = await getFinalizedBlockNumber(client, 'latest');
    expect(n).toBeGreaterThanOrEqual(0n);
  });

  it('block times are fetched', async () => {
    const client = createRpc([anvil.url]);
    const times = await getBlockTimes(client, [0n]);
    expect(times.get(0n)).toBeInstanceOf(Date);
  });

  it('splitRpcUrls: splits by scheme', () => {
    expect(
      splitRpcUrls(['https://a.example', 'ws://b.example', 'wss://c.example', 'http://d.example']),
    ).toEqual({
      http: ['https://a.example', 'http://d.example'],
      ws: ['ws://b.example', 'wss://c.example'],
    });
  });

  it('filterHealthyRpcs: ws endpoints are also verified via chainId', async () => {
    const healthy = await filterHealthyRpcs(
      ['ws://127.0.0.1:1', anvil.wsUrl, anvil.url], 31337,
    );
    expect(healthy).toEqual([anvil.wsUrl, anvil.url]);
  });

  it('createRpc: reads work over a ws endpoint', async () => {
    const client = createRpc([anvil.wsUrl]);
    const n = await getFinalizedBlockNumber(client, 'latest');
    expect(n).toBeGreaterThanOrEqual(0n);
  });

  it('fetchLogs returns empty for an empty range', async () => {
    const client = createRpc([anvil.url]);
    const logs = await fetchLogs(
      client, ['0x0000000000000000000000000000000000000001'], 0n, 0n,
    );
    expect(logs).toEqual([]);
  });
});

describe('blockTimesFromLogs', () => {
  it('reads every block time from the logs when all carry blockTimestamp', () => {
    const times = blockTimesFromLogs([
      { blockNumber: 5n, blockTimestamp: 1_700_000_000n },
      { blockNumber: 6n, blockTimestamp: 1_700_000_001n },
    ]);
    expect(times?.get(5n)?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(times?.size).toBe(2);
  });

  it('gives up for the whole batch if any log lacks it', () => {
    expect(blockTimesFromLogs([{ blockNumber: 5n, blockTimestamp: 1n }, { blockNumber: 6n }])).toBeNull();
    expect(blockTimesFromLogs([{ blockNumber: 5n, blockTimestamp: null }])).toBeNull();
  });

  it('an empty batch needs no times', () => {
    expect(blockTimesFromLogs([])?.size).toBe(0);
  });
});

describe('isRangeCapError', () => {
  it('recognises provider range and result caps', () => {
    expect(isRangeCapError(new Error('ranges over 10000 blocks are not supported on free plan'))).toBe(true);
    expect(isRangeCapError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeCapError(new Error('block range is too large'))).toBe(true);
    expect(isRangeCapError(new Error('Log response size exceeded.'))).toBe(true);
    expect(isRangeCapError(Object.assign(new Error('RPC Request failed.'), { details: 'exceed maximum block range: 2000' }))).toBe(true);
    expect(isRangeCapError(Object.assign(new Error('Invalid parameters were provided to the RPC method.'), { details: 'invalid params: block range too large (max 1000 blocks per eth_getLogs)' }))).toBe(true);
    expect(isRangeCapError(Object.assign(new Error('Invalid parameters were provided to the RPC method.'), { details: 'query exceeds max results 20000, retry with the range 24747323-24748307' }))).toBe(true);
    expect(isRangeCapError(new Error('query exceeds max results 10000'))).toBe(true);
    expect(isRangeCapError(new Error('outer', { cause: new Error('ranges over 100 blocks') }))).toBe(true);
  });

  it('a client-side body-size limit is a result cap too', () => {
    const real = new ResponseBodyTooLargeError({ maxSize: 10485760, size: 10502144 });
    expect(isRangeCapError(real)).toBe(true);
    expect(isRangeCapError(new Error('outer', { cause: real }))).toBe(true);
    const named = Object.assign(new Error('x'), { name: 'ResponseBodyTooLargeError' });
    expect(isRangeCapError(new Error('outer', { cause: named }))).toBe(true);
    expect(isRangeCapError(new Error('HTTP response body exceeded the size limit.  Max: 10485760 bytes Received: 10502144 bytes'))).toBe(true);
  });

  it('recognises the other common provider wordings', () => {
    for (const m of [
      'eth_getLogs is limited to a 10,000 range',
      'eth_getLogs is limited to a 5 range',
      'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.',
      'block range exceeds 1000',
      'max allowed range is 1000 blocks',
      'Query timeout exceeded. Consider reducing your block range.',
    ]) expect(isRangeCapError(new Error(m)), m).toBe(true);
  });

  it('a cap whose request body carries "id":429 is still a cap', () => {
    const err = Object.assign(new Error('RPC Request failed.'), {
      details: 'block range too large', cause: new Error('Request body: {"id":429,"method":"eth_getLogs"}'),
    });
    expect(isRangeCapError(err)).toBe(true);
  });

  it('a rate limit is not a cap, however it is worded', () => {
    expect(isRangeCapError(new Error('Too many requests, try again later'))).toBe(false);
    expect(isRangeCapError(new Error('rate limit exceeded'))).toBe(false);
    expect(isRangeCapError(new Error('HTTP request failed. Status: 429'))).toBe(false);
    expect(isRangeCapError(new Error('HTTP 429 block range too large'))).toBe(false);
    expect(isRangeCapError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isRangeCapError(new Error('fetch failed'))).toBe(false);
  });

  it('other block-range complaints are not caps', () => {
    expect(isRangeCapError(new Error('invalid block range params'))).toBe(false);
    expect(isRangeCapError(new Error('requested block range extends beyond current head'))).toBe(false);
  });
});
