import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crStatusTargetFromEnv, patchCrStatus, reportFatalToCr, startCrStatusLoop } from '../src/crstatus.js';
import { PhaseTracker } from '../src/status.js';

interface Captured {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let baseUrl: string;
let statusCode = 200;
const captured: Captured[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      captured.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = statusCode;
      res.end('{}');
    });
  });
  server.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const target = () => ({ baseUrl, token: 'test-token', namespace: 'default', name: 'demo' });

describe('crStatusTargetFromEnv', () => {
  it('returns null when INDEXER_CR_NAME is missing', () => {
    expect(crStatusTargetFromEnv({})).toBeNull();
  });
  it('returns null when KUBERNETES_SERVICE_HOST is missing', () => {
    expect(crStatusTargetFromEnv({ INDEXER_CR_NAME: 'demo' })).toBeNull();
  });
});

describe('patchCrStatus', () => {
  it('sends the SSA apply-patch request correctly', async () => {
    captured.length = 0;
    await patchCrStatus(target(), { phase: 'Live', currentBlock: 42, headBlock: 42, lag: 0 });
    expect(captured).toHaveLength(1);
    const r = captured[0]!;
    expect(r.method).toBe('PATCH');
    expect(r.url).toBe(
      '/apis/arckive.org/v1alpha1/namespaces/default/indexers/demo/status'
        + '?fieldManager=arckive-worker&force=true&fieldValidation=Strict',
    );
    expect(r.headers.authorization).toBe('Bearer test-token');
    expect(r.headers['content-type']).toBe('application/apply-patch+yaml');
    const body = JSON.parse(r.body) as { status: { phase: string; currentBlock: number } };
    expect(body.status).toEqual({ phase: 'Live', currentBlock: 42, headBlock: 42, lag: 0 });
  });

  it('rejects on a non-2xx response', async () => {
    statusCode = 403;
    await expect(
      patchCrStatus(target(), { phase: 'Live', currentBlock: 1, headBlock: 1, lag: 0 }),
    ).rejects.toThrow(/403/);
    statusCode = 200;
  });
});

describe('startCrStatusLoop', () => {
  it('patches periodically, reflects tracker state, and can be stopped', async () => {
    captured.length = 0;
    const tracker = new PhaseTracker();
    tracker.set('Backfilling');
    tracker.setBlocks(10n, 100n);
    const stop = startCrStatusLoop(target(), tracker, pino({ level: 'silent' }), 25);
    await new Promise((r) => setTimeout(r, 90));
    stop();
    const seen = captured.length;
    expect(seen).toBeGreaterThanOrEqual(2);
    const body = JSON.parse(captured[0]!.body) as { status: { phase: string; lag: number } };
    expect(body.status.phase).toBe('Backfilling');
    expect(body.status.lag).toBe(90);
    await new Promise((r) => setTimeout(r, 60));
    expect(captured.length).toBe(seen); // no requests after stopping
  });
});

describe('reportFatalToCr', () => {
  const log = pino({ level: 'silent' });
  const target = { baseUrl: 'https://x', token: 't', namespace: 'ns', name: 'n' };

  it('patches Degraded with the error message', async () => {
    const calls: unknown[] = [];
    await reportFatalToCr(new Error('schema layout 1'), log, {
      target: () => target, patch: async (t, s) => void calls.push([t, s]),
    });
    expect(calls).toEqual([[target, { phase: 'Degraded', lastError: 'schema layout 1' }]]);
  });

  it('never throws, whether the target or the patch fails, and skips outside a cluster', async () => {
    await expect(reportFatalToCr(new Error('x'), log, { target: () => { throw new Error('no sa'); } })).resolves.toBeUndefined();
    await expect(reportFatalToCr(new Error('x'), log, {
      target: () => target, patch: async () => { throw new Error('HTTP 500'); },
    })).resolves.toBeUndefined();
    let called = false;
    await reportFatalToCr(new Error('x'), log, { target: () => null, patch: async () => void (called = true) });
    expect(called).toBe(false);
  });
});
