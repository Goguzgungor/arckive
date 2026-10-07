import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { Logger } from 'pino';
import type { PhaseTracker } from './status.js';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface CrStatusTarget {
  baseUrl: string;
  token: string;
  ca?: Buffer;
  namespace: string;
  name: string;
}

export interface CrRuntimeStatus {
  phase: string;
  currentBlock: number;
  headBlock: number;
  lag: number;
  lastError?: string;
}

export function crStatusTargetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CrStatusTarget | null {
  const name = env['INDEXER_CR_NAME'];
  const host = env['KUBERNETES_SERVICE_HOST'];
  if (!name || !host) return null;
  const port = env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? env['KUBERNETES_SERVICE_PORT'] ?? '443';
  const namespace =
    env['INDEXER_CR_NAMESPACE'] ?? readFileSync(`${SA_DIR}/namespace`, 'utf8').trim();
  return {
    baseUrl: `https://${host}:${port}`,
    token: readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
    ca: readFileSync(`${SA_DIR}/ca.crt`),
    namespace,
    name,
  };
}

export function patchCrStatus(target: CrStatusTarget, status: Partial<CrRuntimeStatus>): Promise<void> {
  const url = new URL(
    `/apis/arckive.org/v1alpha1/namespaces/${target.namespace}/indexers/${target.name}/status`
      + '?fieldManager=arckive-worker&force=true&fieldValidation=Strict',
    target.baseUrl,
  );
  const body = JSON.stringify({
    apiVersion: 'arckive.org/v1alpha1',
    kind: 'Indexer',
    metadata: { name: target.name, namespace: target.namespace },
    status,
  });
  const opts: RequestOptions = {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${target.token}`,
      'content-type': 'application/apply-patch+yaml',
      'content-length': Buffer.byteLength(body),
    },
    ...(target.ca ? { ca: target.ca } : {}),
  };
  const req = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(url, opts, (res) => {
      res.resume();
      if (res.statusCode !== undefined && res.statusCode < 300) resolve();
      else reject(new Error(`CR status patch failed: HTTP ${res.statusCode}`));
    });
    r.on('error', reject);
    r.end(body);
  });
}

export function startCrStatusLoop(
  target: CrStatusTarget,
  tracker: PhaseTracker,
  log: Logger,
  intervalMs = 10_000,
): () => void {
  const push = (): void => {
    void patchCrStatus(target, {
      phase: tracker.phase,
      currentBlock: Number(tracker.currentBlock),
      headBlock: Number(tracker.headBlock),
      lag: Number(tracker.lag),
      ...(tracker.lastError ? { lastError: tracker.lastError } : {}),
    }).catch((err: unknown) => log.warn({ err }, 'CR status patch failed'));
  };
  push();
  const t = setInterval(push, intervalMs);
  return () => clearInterval(t);
}

// A fatal start-up error (a schema written by another storage layout) ends the
// process before startCrStatusLoop runs, so the CR would keep its old phase
// (Live) next to a worker that is down. Report it once, best effort: a failure
// here is logged and never replaces the error that is being reported. Block
// numbers are left out on purpose — this process never read them, and zeros
// would overwrite the last real progress.
export async function reportFatalToCr(
  err: unknown,
  log: Logger,
  deps: { target?: () => CrStatusTarget | null; patch?: typeof patchCrStatus } = {},
): Promise<void> {
  try {
    const target = (deps.target ?? crStatusTargetFromEnv)();
    if (!target) return;
    await (deps.patch ?? patchCrStatus)(target, {
      phase: 'Degraded',
      lastError: err instanceof Error ? err.message : String(err),
    });
  } catch (e) {
    log.warn({ err: e }, 'could not report the fatal error to the CR status');
  }
}
