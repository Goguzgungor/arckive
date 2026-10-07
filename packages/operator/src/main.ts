import { createServer } from 'node:http';
import { pino } from 'pino';
import { K8s } from 'kubernetes-fluent-client';
import { Indexer } from './kinds.js';
import { createKubeApi } from './kube.js';
import { connectionFromKubeConfig, createKubeHttp } from './kubehttp.js';
import { reconcile, type ReconcileDeps } from './reconcile.js';
import { ReconcileGate } from './gate.js';

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

async function main(): Promise<void> {
  const workerImage = process.env['WORKER_IMAGE'];
  if (!workerImage) throw new Error('WORKER_IMAGE is required');
  const resyncMs = Number(process.env['RESYNC_INTERVAL_MS'] ?? 300_000);
  const healthPort = Number(process.env['HEALTH_PORT'] ?? 8080);

  // one keep-alive client for every get/apply/patch (kubehttp.ts); the
  // fluent client below is used only for the watch
  const kubeHttp = createKubeHttp(await connectionFromKubeConfig());
  const deps: ReconcileDeps = { kube: createKubeApi(kubeHttp), workerImage, log };

  const safeReconcile = async (cr: Indexer): Promise<boolean> => {
    try {
      await reconcile(deps, cr);
      return true;
    } catch (err) {
      log.error({ err, indexer: cr.metadata?.name }, 'reconcile error');
      return false;
    }
  };
  const gate = new ReconcileGate(safeReconcile);

  const health = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  health.listen(healthPort);

  // Status-only events are dropped by the gate (gate.ts); cleanup of deleted
  // CRs is handled by ownerReferences + GC.
  const watcher = K8s(Indexer).Watch((cr, phase) => {
    void gate.watch(cr, phase);
  });
  await watcher.start();

  const resync = setInterval(() => {
    deps.kube
      .listIndexers()
      .then(async (crs) => {
        for (const cr of crs) await gate.resync(cr);
      })
      .catch((err: unknown) => log.error({ err }, 'resync error'));
  }, resyncMs);

  const shutdown = (): void => {
    log.info('shutdown signal received');
    clearInterval(resync);
    watcher.close();
    kubeHttp.close();
    health.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  log.info({ workerImage, resyncMs }, 'arckive operator started');
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'operator failed to start');
  process.exit(1);
});
