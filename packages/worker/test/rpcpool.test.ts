import { createServer, type Server } from 'node:http';
import { HttpRequestError, type PublicClient } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK, RpcPool, checkPoolChain, createRpcPool, endpointLabel, type Call, type PoolEndpoint, type RequestOutcome,
} from '../src/rpcpool.js';

const NO_PACE = { startMs: 0, minMs: 0, maxMs: 0 };
const limited = () => new HttpRequestError({ url: 'http://x', status: 429 });
const down = () => new HttpRequestError({ url: 'http://x', status: 503 });
const tooLarge = () => Object.assign(new Error('response body exceeded the size limit'), { name: 'ResponseBodyTooLargeError' });
const refused = () => new Error('Archive requests require a personal token');

// A fake endpoint: its client is just a name the calls read.
const ep = (name: string, shared = false, chunk = CHUNK): PoolEndpoint =>
  ({ url: `https://${name}.example/key`, client: { name } as unknown as PublicClient, shared, chunk });
const nameOf = (c: PublicClient) => (c as unknown as { name: string }).name;

function harness(endpoints: PoolEndpoint[], start = 0) {
  const clock = { t: start };
  const requests: Array<[number, RequestOutcome]> = [];
  const pool = new RpcPool(endpoints, {
    pace: NO_PACE, now: () => clock.t, sleep: async () => {}, onRequest: (e, o) => requests.push([e, o]),
  });
  return { pool, clock, requests };
}

describe('RpcPool', () => {
  it('cuts calls into chunks of 20, one request each, results in input order', async () => {
    const { pool, requests } = harness([ep('a')]);
    const seenAt: number[] = [];
    const calls: Call<number>[] = Array.from({ length: 41 }, (_, i) => async () => {
      seenAt.push(requests.length); // requests finished before this call started
      return i;
    });
    const out = await pool.all(calls);
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : -1))).toEqual([...Array(41).keys()]);
    expect(requests).toEqual([[0, 'ok'], [0, 'ok'], [0, 'ok']]);
    expect([0, 1, 2].map((k) => seenAt.filter((s) => s === k).length)).toEqual([20, 20, 1]);
  });

  it('never has two requests in flight, even when callers overlap', async () => {
    const { pool } = harness([ep('a')]);
    const log: string[] = [];
    const slow = (tag: string): Call<void> => async () => {
      log.push(`${tag}+`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`${tag}-`);
    };
    await Promise.all([pool.all([slow('A')]), pool.all([slow('B')])]);
    expect(log).toEqual(['A+', 'A-', 'B+', 'B-']);
  });

  it('a rate-limited request rests its endpoint and its calls go to the next one', async () => {
    const { pool, requests, clock } = harness([ep('a'), ep('b')]);
    const call: Call<string> = async (c) => {
      if (nameOf(c) === 'a') throw limited();
      return nameOf(c);
    };
    const first = await pool.all([call, call]);
    expect(first.map((r) => r.status === 'fulfilled' && r.value)).toEqual(['b', 'b']);
    expect(requests).toEqual([[0, 'rate_limited'], [1, 'ok']]);
    // a rests 5 s: the next round starts at b
    clock.t += 4_000;
    await pool.all([call]);
    expect(requests.at(-1)).toEqual([1, 'ok']);
    // after the rest a is asked first again
    clock.t += 1_001;
    await pool.all([call]);
    expect(requests.at(-2)).toEqual([0, 'rate_limited']);
  });

  it('a refusal (any other JSON-RPC answer) moves the call on without resting the endpoint', async () => {
    const { pool, requests } = harness([ep('a'), ep('b')]);
    const out = await pool.all<string>([
      async (c) => { if (nameOf(c) === 'a') throw refused(); return nameOf(c); },
      async (c) => nameOf(c),
    ]);
    expect(out.map((r) => r.status === 'fulfilled' && r.value)).toEqual(['b', 'a']);
    expect(requests).toEqual([[0, 'failed'], [1, 'ok']]);
    await pool.all([async (c) => nameOf(c)]);
    expect(requests.at(-1)).toEqual([0, 'ok']); // a was not resting
  });

  it('tries each endpoint once per chunk, then rejects with the last error', async () => {
    const { pool, requests } = harness([ep('a'), ep('b')]);
    const [r] = await pool.all([async () => { throw refused(); }]);
    expect(r!.status).toBe('rejected');
    expect((r as PromiseRejectedResult).reason.message).toMatch(/personal token/);
    expect(requests.map(([e]) => e)).toEqual([0, 1]);
  });

  it('rest windows double per failure up to 60 s and clear on the next answer', async () => {
    const { pool, clock, requests } = harness([ep('a'), ep('b')]);
    let aDown = true;
    const call: Call<string> = async (c) => {
      if (nameOf(c) === 'a' && aDown) throw down();
      return nameOf(c);
    };
    // which endpoint a one-call round asks first
    const firstAsked = async () => {
      requests.length = 0;
      await pool.all([call]);
      return requests[0]![0];
    };
    for (const rest of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      expect(await firstAsked()).toBe(0); // a is asked, fails, rests `rest`
      clock.t += rest - 1;
      expect(await firstAsked()).toBe(1); // still resting: b goes first
      clock.t += 1;
    }
    aDown = false;
    expect(await firstAsked()).toBe(0); // a answers: its rest is cleared
    aDown = true;
    expect(await firstAsked()).toBe(0); // fails again: back to the first rest, 5 s
    clock.t += 5_000;
    expect(await firstAsked()).toBe(0);
  });

  it('when every endpoint rests, asks the one whose rest ends first', async () => {
    const { pool, clock, requests } = harness([ep('a'), ep('b')]);
    const failing = new Set(['a']);
    const call: Call<string> = async (c) => {
      if (failing.has(nameOf(c))) throw down();
      return nameOf(c);
    };
    await pool.all([call]); // t=0: a fails, rests until 5 s
    clock.t = 5_000;
    await pool.all([call]); // a fails again, rests until 15 s
    failing.add('b');
    clock.t = 6_000;
    await pool.all([call]); // b fails, rests until 11 s; a is asked anyway, rests until 26 s
    clock.t = 7_000;
    requests.length = 0;
    await pool.all([call]);
    expect(requests.map(([e]) => e)).toEqual([1, 0]); // b's rest ends first
  });

  it('a response too large is halved on the same endpoint; one call alone too large fails', async () => {
    const { pool, requests } = harness([ep('a'), ep('b')]);
    // the calls of one request start in the same tick: they share `open`
    let open: { size: number } | null = null;
    const calls: Call<number>[] = Array.from({ length: 8 }, (_, i) => async () => {
      const req = open ?? (open = { size: 0 });
      req.size++;
      queueMicrotask(() => { open = null; });
      await null; // every call of the request has counted itself by now
      if (i === 7) throw tooLarge(); // too large even alone
      if (req.size > 2) throw tooLarge(); // a request of more than two calls is too large
      return i;
    });
    const out = await pool.all(calls);
    expect(out.slice(0, 7).map((r) => r.status)).toEqual(Array(7).fill('fulfilled'));
    expect(out[7]!.status).toBe('rejected');
    expect(requests.every(([e]) => e === 0)).toBe(true); // halving stays on the endpoint
  });

  it('backOffShared slows only the endpoints ingest also uses', async () => {
    const waits: number[] = [];
    const pool = new RpcPool([ep('a', true), ep('b', false)], {
      pace: { startMs: 100, minMs: 100, maxMs: 1000 }, now: () => 0, sleep: async (ms) => { waits.push(ms); },
    });
    pool.backOffShared();
    await pool.all([async (c) => nameOf(c)]); // a (shared) waits its doubled interval
    expect(waits).toEqual([200]);
  });
});

describe('endpointLabel', () => {
  it('names an endpoint by index and host, never its path', () => {
    expect(endpointLabel(2, 'https://rpc.example.com/v1/SECRETKEY')).toBe('2:rpc.example.com');
    expect(endpointLabel(0, 'not a url')).toBe('0:?');
  });
});

describe('createRpcPool', () => {
  it('batches http endpoints by 20, takes ws ones one call per request, and marks ingest\'s as shared', () => {
    const pool = createRpcPool(
      ['https://a.example', 'wss://b.example', 'https://c.example/'],
      ['https://c.example', 'https://ingest.example'],
      { pace: NO_PACE },
    );
    expect(pool.endpoints).toEqual([
      { label: '0:a.example', chunk: 20, shared: false },
      { label: '1:b.example', chunk: 1, shared: false },
      { label: '2:c.example', chunk: 20, shared: true },
    ]);
  });
});

describe('checkPoolChain', () => {
  it('drops an endpoint on another chain and keeps one that does not answer', async () => {
    const errors: unknown[] = [];
    const kept = await checkPoolChain(
      ['https://a.example', 'https://b.example', 'https://c.example'], 5042,
      { error: (o: unknown) => errors.push(o) },
      async (url) => {
        if (url.includes('b.')) return 1;
        if (url.includes('c.')) throw new Error('down');
        return 5042;
      },
    );
    expect(kept).toEqual(['https://a.example', 'https://c.example']);
    expect(errors).toHaveLength(1);
  });
});

describe('RpcPool over HTTP (viem batching)', () => {
  const servers: Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  // Each request body is recorded; `answer` decides the reply.
  async function rpcServer(answer: (body: Array<{ id: number }>) => { status: number; json?: unknown }) {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data);
        bodies.push(body);
        const { status, json } = answer(Array.isArray(body) ? body : [body]);
        res.writeHead(status, { 'content-type': 'application/json' }).end(json === undefined ? '' : JSON.stringify(json));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies };
  }
  const ok = (body: Array<{ id: number }>) => ({
    status: 200, json: body.map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x' })),
  });
  const code = (i: number): Call<unknown> => (c) => c.getCode({ address: `0x${i.toString(16).padStart(40, '0')}` });

  it('sends 20 calls as one JSON-RPC array', async () => {
    const a = await rpcServer(ok);
    const pool = createRpcPool([a.url], [], { pace: NO_PACE });
    const out = await pool.all(Array.from({ length: 20 }, (_, i) => code(i)));
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(a.bodies).toHaveLength(1);
    expect((a.bodies[0] as unknown[]).length).toBe(20);
  });

  it('an HTTP 429 sends the batch to the next endpoint once, with no transport retry', async () => {
    const a = await rpcServer(() => ({ status: 429 }));
    const b = await rpcServer(ok);
    const pool = createRpcPool([a.url, b.url], [], { pace: NO_PACE });
    const out = await pool.all(Array.from({ length: 5 }, (_, i) => code(i)));
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies).toHaveLength(1);
    await pool.all([code(9)]); // a rests
    expect(a.bodies).toHaveLength(1);
  });

  it('a batch answered with an empty array moves every call on, without resting the endpoint', async () => {
    const a = await rpcServer(() => ({ status: 200, json: [] }));
    const b = await rpcServer(ok);
    const pool = createRpcPool([a.url, b.url], [], { pace: NO_PACE });
    const out = await pool.all([code(1), code(2)]);
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
    await pool.all([code(3)]);
    expect(a.bodies).toHaveLength(2); // asked again: not resting
  });
});
