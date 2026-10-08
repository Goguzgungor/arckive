import type { Logger } from 'pino';
import { IndexerSpecSchema, type IndexerCondition } from '@arckive/core';
import type { Indexer } from './kinds.js';
import type { KubeApi } from './kube.js';
import { desiredResources } from './resources.js';

export interface ReconcileDeps {
  kube: KubeApi;
  workerImage: string;
  log: Logger;
}

function condition(
  status: 'True' | 'False',
  reason: string,
  message?: string,
): IndexerCondition {
  return {
    type: 'Provisioned',
    status,
    reason,
    ...(message ? { message } : {}),
    lastTransitionTime: new Date().toISOString(),
  };
}

// 'waiting': a Secret or ConfigMap the Indexer names does not exist (yet).
// Creating it is no event on the Indexer, and the manifests are often applied
// Indexer first, so the gate (gate.ts) asks again soon rather than at the
// next resync. Everything else is 'ok' — an invalid spec included: only a
// spec change fixes that, and a spec change is a new generation, an event of
// its own.
export type ReconcileOutcome = 'ok' | 'waiting';

export async function reconcile(deps: ReconcileDeps, cr: Indexer): Promise<ReconcileOutcome> {
  const name = cr.metadata?.name;
  const namespace = cr.metadata?.namespace;
  const uid = cr.metadata?.uid;
  if (!name || !namespace || !uid) return 'ok';

  // Do not re-patch an unchanged status: every patch produces a new watch
  // event and leads to a reconcile storm (self-feeding loop → OOM).
  const current = cr.status?.conditions?.find((c) => c.type === 'Provisioned');
  const setCondition = (c: IndexerCondition) => {
    const unchanged =
      cr.status?.observedGeneration === cr.metadata?.generation &&
      current?.status === c.status &&
      current?.reason === c.reason &&
      current?.message === c.message;
    if (unchanged) return Promise.resolve();
    return deps.kube.patchIndexerStatus(namespace, name, {
      observedGeneration: cr.metadata?.generation,
      conditions: [c],
    });
  };

  const parsed = IndexerSpecSchema.safeParse(cr.spec);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    await setCondition(condition('False', 'InvalidSpec', detail));
    return 'ok';
  }
  const spec = parsed.data;

  for (const c of spec.contracts) {
    const ref = c.abi?.configMapRef;
    if (!ref) continue; // inline / explorer-fetched ABI — nothing to validate here
    const cm = await deps.kube.getConfigMap(namespace, ref.name);
    if (!cm?.data?.[ref.key]) {
      await setCondition(
        condition('False', 'MissingAbiConfigMap', `ConfigMap ${ref.name}/${ref.key} not found`),
      );
      return 'waiting';
    }
  }

  const dsnRef = spec.storage.external.dsnSecretRef;
  const secret = await deps.kube.getSecret(namespace, dsnRef.name);
  if (!secret?.data?.[dsnRef.key]) {
    await setCondition(
      condition('False', 'MissingDsnSecret', `Secret ${dsnRef.name}/${dsnRef.key} not found`),
    );
    return 'waiting';
  }

  const headerRef = spec.insights?.laya.headerSecretRef;
  if (headerRef) {
    const headerSecret = await deps.kube.getSecret(namespace, headerRef.name);
    if (!headerSecret?.data?.[headerRef.key]) {
      await setCondition(
        condition('False', 'MissingInsightsSecret', `Secret ${headerRef.name}/${headerRef.key} not found`),
      );
      return 'waiting';
    }
  }

  const desired = desiredResources({
    namespace,
    owner: { name, uid },
    spec,
    workerImage: deps.workerImage,
  });
  await deps.kube.applyServiceAccount(desired.serviceAccount);
  await deps.kube.applyRole(desired.role);
  await deps.kube.applyRoleBinding(desired.roleBinding);
  await deps.kube.applyConfigMap(desired.configMap);
  await deps.kube.applyDeployment(desired.deployment);
  await setCondition(condition('True', 'Reconciled'));
  deps.log.info({ indexer: name, namespace, hash: desired.hash }, 'reconcile done');
  return 'ok';
}
