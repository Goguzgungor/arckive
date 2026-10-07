import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from 'node:https';
import { KubeConfig } from '@kubernetes/client-node';

// The operator's Kubernetes API client for gets, applies and status patches.
//
// kubernetes-fluent-client (3.11.7, and 3.12.4 still) builds a new undici
// Agent with a 10-minute keep-alive for every request and never closes it,
// so each request left a TLS connection open for ten minutes: ~145 requests
// a minute at one reconcile per 3.3 s held ~1,450 connections and filled the
// operator's 256 Mi. This client keeps one agent for the process. The
// library is still used for the watch — one long-lived connection.

export class KubeHttpError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path}: HTTP ${status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    this.name = 'KubeHttpError';
    this.status = status;
  }
}

export interface KubeConnection {
  server: string; // https://host:port (http:// in tests)
  tls: Pick<RequestOptions, 'ca' | 'cert' | 'key' | 'rejectUnauthorized' | 'servername'>;
  // asked per request: a projected service-account token rotates
  headers: () => Promise<Record<string, string>>;
}

export interface KubeHttp {
  get(path: string): Promise<unknown>; // null on 404
  patch(path: string, contentType: string, body: unknown): Promise<unknown>;
  close(): void;
}

export function createKubeHttp(conn: KubeConnection): KubeHttp {
  const secure = conn.server.startsWith('https:');
  const agent = secure
    ? new HttpsAgent({ keepAlive: true, maxSockets: 4, ...conn.tls })
    : new HttpAgent({ keepAlive: true, maxSockets: 4 });

  async function send(method: 'GET' | 'PATCH', path: string, body?: { type: string; json: unknown }) {
    const url = new URL(path, conn.server);
    const data = body ? JSON.stringify(body.json) : undefined;
    const headers: Record<string, string | number> = { accept: 'application/json', ...(await conn.headers()) };
    if (body) {
      headers['content-type'] = body.type;
      headers['content-length'] = Buffer.byteLength(data!);
    }
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = (secure ? httpsRequest : httpRequest)(url, { method, agent, headers, timeout: 30_000 }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timed out`)));
      req.on('error', reject);
      req.end(data);
    });
  }

  function parse(method: string, path: string, r: { status: number; text: string }): unknown {
    if (r.status < 200 || r.status >= 300) throw new KubeHttpError(method, path, r.status, r.text);
    return r.text ? JSON.parse(r.text) : null;
  }

  return {
    async get(path) {
      const r = await send('GET', path);
      return r.status === 404 ? null : parse('GET', path, r);
    },
    async patch(path, contentType, json) {
      return parse('PATCH', path, await send('PATCH', path, { type: contentType, json }));
    },
    close() {
      agent.destroy();
    },
  };
}

function loadDefault(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault(); // KUBECONFIG / ~/.kube/config, else the in-cluster service account
  return kc;
}

export async function connectionFromKubeConfig(kc: KubeConfig = loadDefault()): Promise<KubeConnection> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('no current Kubernetes cluster in the kubeconfig');
  const first: RequestOptions = {};
  await kc.applyToHTTPSOptions(first);
  return {
    server: cluster.server,
    tls: {
      ca: first.ca, cert: first.cert, key: first.key,
      rejectUnauthorized: first.rejectUnauthorized, servername: first.servername,
    },
    // applyToHTTPSOptions also builds an https.Agent each time; it is never
    // used, so it never opens a socket — only the headers are taken from it
    headers: async () => {
      const o: RequestOptions = {};
      await kc.applyToHTTPSOptions(o);
      return { ...((o.headers ?? {}) as Record<string, string>) };
    },
  };
}
