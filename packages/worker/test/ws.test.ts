import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subscribeNewHeads } from '../src/ws.js';
import { startAnvil, type AnvilHandle } from './helpers/anvil.js';
import { acceptSubscribe, headFrame, startFakeWs } from './helpers/wsserver.js';

const log = pino({ level: 'silent' });

const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

const mine = (url: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
  });

describe('subscribeNewHeads', () => {
  let anvil: AnvilHandle;
  beforeAll(async () => {
    anvil = await startAnvil();
  });
  afterAll(() => anvil.stop());

  it('when a new block is mined, onHead fires with a payload (number+timestamp)', async () => {
    const heads: { number: bigint; timestamp: Date }[] = [];
    let primaryFlag: boolean | null = null;
    const states: boolean[] = [];
    const sub = subscribeNewHeads({
      wsUrls: [anvil.wsUrl],
      onHead: (head, primary) => {
        if (head) heads.push(head);
        primaryFlag = primary;
      },
      onStateChange: (c) => states.push(c),
      log,
    });
    await until(() => states.includes(true));
    await mine(anvil.url);
    await until(() => heads.length >= 1);
    sub.close();
    expect(heads[0]!.number).toBeGreaterThan(0n);
    expect(heads[0]!.timestamp.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(primaryFlag).toBe(true);
  });

  it('subscribes to two endpoints in parallel; announcements from the second arrive with primary=false', async () => {
    const second = await startAnvil();
    const seen: boolean[] = [];
    const sub = subscribeNewHeads({
      wsUrls: [anvil.wsUrl, second.wsUrl],
      onHead: (_head, primary) => seen.push(primary),
      onStateChange: () => {},
      log,
    });
    await new Promise((r) => setTimeout(r, 500)); // let both subscriptions open
    await mine(second.url);
    await until(() => seen.includes(false));
    sub.close();
    second.stop();
    expect(seen).toContain(false);
  });

  it('when the server dies, onStateChange(false) is delivered', async () => {
    const local = await startAnvil();
    const states: boolean[] = [];
    const sub = subscribeNewHeads({
      wsUrls: [local.wsUrl],
      onHead: () => {},
      onStateChange: (c) => states.push(c),
      log,
    });
    await until(() => states.includes(true));
    local.stop();
    await until(() => states.includes(false));
    sub.close();
    expect(states.at(-1)).toBe(false);
  });
});

describe('subscribeNewHeads against an endpoint anvil cannot imitate', () => {
  it('frames that are not JSON-RPC text are ignored and the subscription keeps delivering heads', async () => {
    const srv = await startFakeWs((sock) =>
      acceptSubscribe(sock, () => {
        sock.send('<html>502 Bad Gateway</html>');
        sock.send(Buffer.from([1, 2, 3]));
        sock.send('null');
        sock.send('"keepalive"');
        sock.send(headFrame(7));
      }),
    );
    const heads: bigint[] = [];
    const states: boolean[] = [];
    const sub = subscribeNewHeads({
      wsUrls: [srv.url],
      onHead: (head) => {
        if (head) heads.push(head.number);
      },
      onStateChange: (c) => states.push(c),
      log,
    });
    await until(() => heads.length >= 1);
    sub.close();
    await srv.stop();
    expect(heads).toEqual([7n]);
    expect(states).toEqual([true]);
  });

  it('an eth_subscribe error reply is not a subscription: the endpoint stays down and is retried', async () => {
    const states: boolean[] = [];
    // Taken when the client reopens, before anything is said on that socket:
    // the only state change by then would be the refused reply counted as up.
    let statesWhenReopened: boolean[] | null = null;
    const srv = await startFakeWs((sock, n) => {
      if (n === 2) statesWhenReopened = states.slice();
      sock.on('message', (data) => {
        const m = JSON.parse(String(data)) as { id?: number; method?: string };
        if (m.method !== 'eth_subscribe') return;
        const reply =
          n === 1
            ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not supported' } }
            : { jsonrpc: '2.0', id: m.id, result: '0x1' };
        sock.send(JSON.stringify(reply));
      });
    });
    const sub = subscribeNewHeads({
      wsUrls: [srv.url],
      onHead: () => {},
      onStateChange: (c) => states.push(c),
      log,
    });
    await until(() => states.includes(true), 5_000); // reopened after the 1 s backoff
    sub.close();
    await srv.stop();
    expect(srv.conns.length).toBe(2);
    expect(statesWhenReopened).toEqual([]);
    expect(states).toEqual([true]);
  });

  it('a connection silent for idleMs is dropped and reopened', async () => {
    const srv = await startFakeWs((sock, n) =>
      acceptSubscribe(sock, () => {
        if (n === 2) sock.send(headFrame(9));
      }),
    );
    const states: boolean[] = [];
    const heads: bigint[] = [];
    const sub = subscribeNewHeads({
      wsUrls: [srv.url],
      idleMs: 300,
      onHead: (head) => {
        if (head) heads.push(head.number);
      },
      onStateChange: (c) => states.push(c),
      log,
    });
    await until(() => heads.length >= 1, 5_000);
    sub.close();
    await srv.stop();
    expect(srv.conns.length).toBeGreaterThanOrEqual(2);
    expect(states.slice(0, 3)).toEqual([true, false, true]);
  });
});
