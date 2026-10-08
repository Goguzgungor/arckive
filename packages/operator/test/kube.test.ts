import { createServer, type IncomingMessage, type Server } from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it } from 'vitest';
import { createKubeApi } from '../src/kube.js';
import { KubeHttpError, connectionFromKubeConfig, createKubeHttp } from '../src/kubehttp.js';

interface Seen { method: string; url: string; type?: string; auth?: string; body: string }

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); } });

async function apiServer(reply: (req: IncomingMessage) => { status: number; json?: unknown }) {
  const seen: Seen[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, type: req.headers['content-type'], auth: req.headers['authorization'], body });
      const { status, json } = reply(req);
      res.writeHead(status, { 'content-type': 'application/json' }).end(json === undefined ? '' : JSON.stringify(json));
    });
  });
  server.on('connection', () => connections++);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let n = 0;
  const http = createKubeHttp({
    server: `http://127.0.0.1:${port}`, tls: {},
    headers: async () => ({ authorization: `Bearer t${n++}` }),
  });
  return { http, seen, connections: () => connections };
}

describe('createKubeApi over KubeHttp', () => {
  it('gets a ConfigMap and a Secret; a 404 is null', async () => {
    const s = await apiServer((req) => (req.url!.endsWith('/missing') ? { status: 404 } : { status: 200, json: { data: { k: 'v' } } }));
    const api = createKubeApi(s.http);
    expect(await api.getConfigMap('ns', 'abi')).toEqual({ data: { k: 'v' } });
    expect(await api.getSecret('ns', 'missing')).toBeNull();
    expect(s.seen.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /api/v1/namespaces/ns/configmaps/abi',
      'GET /api/v1/namespaces/ns/secrets/missing',
    ]);
  });

  it('applies server-side, forced and strict, as pepr', async () => {
    const s = await apiServer(() => ({ status: 200, json: {} }));
    const api = createKubeApi(s.http);
    const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'w', namespace: 'ns' }, spec: { replicas: 1 } };
    await api.applyDeployment(deployment as never);
    await api.applyRole({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'r', namespace: 'ns' } } as never);
    await api.applyConfigMap({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', namespace: 'ns' } } as never);
    expect(s.seen.map((x) => `${x.method} ${x.url} ${x.type}`)).toEqual([
      'PATCH /apis/apps/v1/namespaces/ns/deployments/w?fieldManager=pepr&fieldValidation=Strict&force=true application/apply-patch+yaml',
      'PATCH /apis/rbac.authorization.k8s.io/v1/namespaces/ns/roles/r?fieldManager=pepr&fieldValidation=Strict&force=true application/apply-patch+yaml',
      'PATCH /api/v1/namespaces/ns/configmaps/c?fieldManager=pepr&fieldValidation=Strict&force=true application/apply-patch+yaml',
    ]);
    expect(JSON.parse(s.seen[0]!.body)).toEqual(deployment);
  });

  it('applies ServiceAccounts and RoleBindings on their paths', async () => {
    const s = await apiServer(() => ({ status: 200, json: {} }));
    const api = createKubeApi(s.http);
    await api.applyServiceAccount({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'sa', namespace: 'ns' } } as never);
    await api.applyRoleBinding({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'rb', namespace: 'ns' } } as never);
    expect(s.seen.map((x) => x.url)).toEqual([
      '/api/v1/namespaces/ns/serviceaccounts/sa?fieldManager=pepr&fieldValidation=Strict&force=true',
      '/apis/rbac.authorization.k8s.io/v1/namespaces/ns/rolebindings/rb?fieldManager=pepr&fieldValidation=Strict&force=true',
    ]);
  });

  it('rejects when the server cuts the response off mid-body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"data":');
      setTimeout(() => res.socket!.destroy(), 20);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const http = createKubeHttp({ server: `http://127.0.0.1:${port}`, tls: {}, headers: async () => ({}) });
    await expect(createKubeApi(http).getSecret('ns', 'x')).rejects.toThrow();
    http.close();
  });

  it('a 2xx body that is not JSON fails without quoting the body', async () => {
    const server = createServer((_req, res) => res.writeHead(200).end('SECRET-VALUE not json'));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const http = createKubeHttp({ server: `http://127.0.0.1:${port}`, tls: {}, headers: async () => ({}) });
    const err = await createKubeApi(http).getSecret('ns', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KubeHttpError);
    expect((err as Error).message).not.toContain('SECRET-VALUE');
    http.close();
  });

  it('listing Indexers throws on a 404 (CRD missing)', async () => {
    const s = await apiServer(() => ({ status: 404 }));
    await expect(createKubeApi(s.http).listIndexers()).rejects.toMatchObject({ name: 'KubeHttpError', status: 404 });
  });

  it('merge-patches the Indexer status and lists Indexers', async () => {
    const s = await apiServer((req) => (req.method === 'GET' ? { status: 200, json: { items: [{ metadata: { name: 'a' } }] } } : { status: 200, json: {} }));
    const api = createKubeApi(s.http);
    await api.patchIndexerStatus('ns', 'demo', { observedGeneration: 3 });
    expect(await api.listIndexers()).toEqual([{ metadata: { name: 'a' } }]);
    expect(s.seen[0]).toMatchObject({
      method: 'PATCH', url: '/apis/arckive.org/v1alpha1/namespaces/ns/indexers/demo/status', type: 'application/merge-patch+json',
    });
    expect(JSON.parse(s.seen[0]!.body)).toEqual({ status: { observedGeneration: 3 } });
    expect(s.seen[1]).toMatchObject({ method: 'GET', url: '/apis/arckive.org/v1alpha1/indexers' });
  });

  it('throws KubeHttpError with the status for anything but 2xx (and 404 on a get)', async () => {
    const s = await apiServer((req) => (req.method === 'GET' ? { status: 403, json: { message: 'forbidden' } } : { status: 500 }));
    const api = createKubeApi(s.http);
    await expect(api.getSecret('ns', 'x')).rejects.toMatchObject({ name: 'KubeHttpError', status: 403 });
    await expect(api.patchIndexerStatus('ns', 'x', {})).rejects.toBeInstanceOf(KubeHttpError);
  });

  it('asks for the auth header on every request, so a rotated token is used', async () => {
    const s = await apiServer(() => ({ status: 200, json: {} }));
    const api = createKubeApi(s.http);
    await api.getConfigMap('ns', 'a');
    await api.getConfigMap('ns', 'b');
    expect(s.seen.map((x) => x.auth)).toEqual(['Bearer t0', 'Bearer t1']);
  });

  it('50 requests share one connection', async () => {
    const s = await apiServer(() => ({ status: 200, json: {} }));
    const api = createKubeApi(s.http);
    for (let i = 0; i < 50; i++) await api.getConfigMap('ns', `c${i}`);
    expect(s.connections()).toBe(1);
    s.http.close();
  });
});

describe('connectionFromKubeConfig', () => {
  it('takes the server, TLS settings and a bearer token from a kubeconfig', async () => {
    const kc = new KubeConfig();
    kc.loadFromString(`apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://127.0.0.1:6443", insecure-skip-tls-verify: true } }]
users: [{ name: u, user: { token: tok } }]
contexts: [{ name: x, context: { cluster: c, user: u } }]
current-context: x
`);
    const conn = await connectionFromKubeConfig(kc);
    expect(conn.server).toBe('https://127.0.0.1:6443');
    expect(conn.tls.rejectUnauthorized).toBe(false);
    expect(await conn.headers()).toMatchObject({ Authorization: 'Bearer tok' });
  });
});
