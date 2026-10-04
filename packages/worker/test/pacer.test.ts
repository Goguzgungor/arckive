import { HttpRequestError, LimitExceededRpcError, RpcRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { Pacer, isRateLimited } from '../src/pacer.js';

const limits = { startMs: 250, minMs: 50, maxMs: 8000 };

describe('Pacer', () => {
  it('runs one call at a time, starts spaced by the interval', async () => {
    let t = 0;
    const pacer = new Pacer({ startMs: 250, minMs: 250, maxMs: 250 }, () => t, async (ms) => { t += ms; });
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const work = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(t);
      await Promise.resolve();
      t += 10;
      inFlight--;
    };
    await Promise.all([pacer.run(work), pacer.run(work), pacer.run(work)]);
    expect(maxInFlight).toBe(1);
    expect(starts).toEqual([0, 250, 500]);
  });

  it('a failed call does not stop the ones queued behind it', async () => {
    const pacer = new Pacer({ startMs: 0, minMs: 0, maxMs: 0 });
    const failed = pacer.run(async () => { throw new Error('boom'); });
    const ok = pacer.run(async () => 7);
    await expect(failed).rejects.toThrow('boom');
    await expect(ok).resolves.toBe(7);
  });

  it('halves its pace when the endpoint says it is rate-limited, and speeds up as calls succeed', async () => {
    const pacer = new Pacer(limits, () => 0, async () => {});
    const limited = new LimitExceededRpcError(new RpcRequestError({ body: {}, error: { code: -32005, message: 'rate limit exceeded' }, url: 'x' }));
    await expect(pacer.run(async () => { throw limited; })).rejects.toBe(limited);
    expect(pacer.intervalMs).toBe(500);
    for (let i = 0; i < 200; i++) await pacer.run(async () => undefined);
    expect(pacer.intervalMs).toBe(50);
    pacer.backOff();
    expect(pacer.intervalMs).toBe(100);
  });

  it('other failures do not change the pace, and it never backs off past the cap', async () => {
    const pacer = new Pacer(limits, () => 0, async () => {});
    await expect(pacer.run(async () => { throw new Error('reverted'); })).rejects.toThrow();
    expect(pacer.intervalMs).toBe(250);
    for (let i = 0; i < 20; i++) pacer.backOff();
    expect(pacer.intervalMs).toBe(8000);
  });
});

describe('isRateLimited', () => {
  it('recognises -32005 and HTTP 429, wrapped or not', () => {
    const rpc = new LimitExceededRpcError(new RpcRequestError({ body: {}, error: { code: -32005, message: 'x' }, url: 'x' }));
    expect(isRateLimited(rpc)).toBe(true);
    expect(isRateLimited(new HttpRequestError({ url: 'x', status: 429 }))).toBe(true);
    expect(isRateLimited(new HttpRequestError({ url: 'x', status: 500 }))).toBe(false);
    expect(isRateLimited(new Error('rate limit'))).toBe(false);
  });
});
