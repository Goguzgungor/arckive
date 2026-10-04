import { describe, expect, it } from 'vitest';
import { LANE_QUESTION } from '@arckive/core';
import { BATCH_MAX, LayaClient, LayaError, parseHeaderLine } from '../src/laya.js';

interface Call { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

const lanesFor = (init: RequestInit) => {
  const { states } = JSON.parse(String(init.body)) as { states: string[] };
  return new Response(JSON.stringify({
    results: states.map(() => ({ answers: { lane: { choice: 'swap', probabilities: { swap: 0.9, bridge: 0.1 } } } })),
  }));
};

function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { slept.push(ms); t += ms; },
    slept,
  };
}

describe('parseHeaderLine', () => {
  it('splits at the first colon and trims', () => {
    expect(parseHeaderLine('Authorization: Bearer a:b')).toEqual({ name: 'Authorization', value: 'Bearer a:b' });
    expect(parseHeaderLine('X-Api-Key:k')).toEqual({ name: 'X-Api-Key', value: 'k' });
  });

  it('drops the newline a Secret file usually ends with', () => {
    expect(parseHeaderLine('Authorization: Bearer t\n')).toEqual({ name: 'Authorization', value: 'Bearer t' });
  });

  it('refuses a value that could split into another header, without echoing it', () => {
    for (const bad of ['Authorization: Bearer secret-token\nX-Other: y', 'Authorization: Bearer secret\r-token', 'Authorization: secret-token\u0000', 'Authorization: secret-token’']) {
      expect(() => parseHeaderLine(bad)).toThrow(LayaError);
      try { parseHeaderLine(bad); } catch (err) { expect(String(err)).not.toContain('secret-token'); }
    }
  });

  it('refuses a malformed line without echoing it', () => {
    for (const bad of ['no-colon secret-token', ': secret-token', 'Bad Name: secret-token']) {
      expect(() => parseHeaderLine(bad)).toThrow(LayaError);
      try { parseHeaderLine(bad); } catch (err) { expect(String(err)).not.toContain('secret-token'); }
    }
  });
});

describe('LayaClient.classify', () => {
  it('posts the lane question with the header and a fixed User-Agent', async () => {
    const f = fakeFetch((_u, init) => lanesFor(init));
    const client = new LayaClient('https://gate.example/', { name: 'Authorization', value: 'Bearer t' }, { fetch: f.fn });
    const out = await client.classify(['a', 'b', 'a']);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://gate.example/ai/run/batch');
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer t');
    expect(headers['user-agent']).toBe('arckive-worker');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ states: ['a', 'b'], questions: { lane: LANE_QUESTION } });
    expect(out.get('a')).toEqual({ choice: 'swap', probabilities: { swap: 0.9, bridge: 0.1 } });
  });

  it('sends at most 64 states a call, a second apart', async () => {
    const f = fakeFetch((_u, init) => lanesFor(init));
    const clock = fakeClock();
    let calls = 0;
    const client = new LayaClient('https://g', null, { fetch: f.fn, now: clock.now, sleep: clock.sleep, onCall: () => calls++ });
    const sentences = Array.from({ length: BATCH_MAX * 2 + 2 }, (_, i) => `s${i}`);
    const out = await client.classify(sentences);
    expect(out.size).toBe(sentences.length);
    expect(f.calls.map((c) => (JSON.parse(String(c.init.body)) as { states: string[] }).states.length)).toEqual([64, 64, 2]);
    expect(clock.slept).toEqual([1000, 1000]);
    expect(calls).toBe(3);
  });

  it('answers a sentence it has seen from the cache', async () => {
    const f = fakeFetch((_u, init) => lanesFor(init));
    let hits = 0;
    const client = new LayaClient('https://g', null, { fetch: f.fn, sleep: async () => {}, onCacheHits: (n) => (hits += n) });
    await client.classify(['a', 'b']);
    await client.classify(['b', 'c']);
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(String(f.calls[1]!.init.body)).states).toEqual(['c']);
    expect(hits).toBe(1);
  });

  it('turns HTTP errors, bad bodies and unreachable gates into LayaError', async () => {
    const status = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response('no', { status: 401 })).fn });
    await expect(status.classify(['a'])).rejects.toMatchObject({ name: 'LayaError', status: 401 });
    const short = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response(JSON.stringify({ results: [] }))).fn });
    await expect(short.classify(['a'])).rejects.toBeInstanceOf(LayaError);
    const down = new LayaClient('https://g', null, { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.classify(['a'])).rejects.toBeInstanceOf(LayaError);
  });

  it('never carries what fetch said into the error, which can quote the header', async () => {
    const leaky = (async () => {
      throw new TypeError('Headers.append: "Bearer TOPSECRET" is an invalid header value.', { cause: Object.assign(new Error('x'), { code: 'ERR_INVALID_CHAR' }) });
    }) as typeof fetch;
    const client = new LayaClient('https://g', null, { fetch: leaky });
    const err = await client.classify(['a']).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(LayaError);
    const chain = [err.message, String((err as Error & { cause?: unknown }).cause ?? '')].join(' ');
    expect(chain).not.toContain('TOPSECRET');
    expect(err.message).toContain('TypeError');
  });
});

describe('LayaClient.identity', () => {
  it('reads the model name, or null when the gate does not say', async () => {
    const ok = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response(JSON.stringify({ model: 'laya-322m' }))).fn });
    expect(await ok.identity()).toBe('laya-322m');
    const down = new LayaClient('https://g', null, { fetch: fakeFetch(() => new Response('', { status: 503 })).fn });
    expect(await down.identity()).toBeNull();
  });
});
