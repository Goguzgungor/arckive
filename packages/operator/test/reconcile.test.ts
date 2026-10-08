import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { kind } from 'kubernetes-fluent-client';
import type { IndexerStatus } from '@arckive/core';
import type { Indexer } from '../src/kinds.js';
import type { KubeApi } from '../src/kube.js';
import { reconcile } from '../src/reconcile.js';

const log = pino({ level: 'silent' });
const ADDR = `0x${'ab'.repeat(20)}`;

function makeCr(): Indexer {
  return {
    apiVersion: 'arckive.org/v1alpha1',
    kind: 'Indexer',
    metadata: { name: 'demo', namespace: 'default', uid: 'uid-1', generation: 3 },
    spec: {
      network: { chainId: 31337, rpc: ['http://anvil:8545'] },
      storage: { mode: 'External', external: { dsnSecretRef: { name: 'pg-dsn', key: 'url' } } },
      contracts: [
        { name: 'emitter', address: ADDR, abi: { configMapRef: { name: 'emitter-abi', key: 'abi.json' } } },
      ],
    },
  } as Indexer;
}

interface FakeKube extends KubeApi {
  applied: string[];
  statusPatches: IndexerStatus[];
}

function makeFake(
  opts: {
    cms?: Record<string, Record<string, string>>;
    secrets?: Record<string, Record<string, string>>;
  } = {},
): FakeKube {
  const cms = opts.cms ?? { 'emitter-abi': { 'abi.json': '[]' } };
  const secrets = opts.secrets ?? { 'pg-dsn': { url: 'ZHNu' } };
  const fake: FakeKube = {
    applied: [],
    statusPatches: [],
    getConfigMap: (_ns, name) =>
      Promise.resolve(cms[name] ? ({ data: cms[name] } as kind.ConfigMap) : null),
    getSecret: (_ns, name) =>
      Promise.resolve(secrets[name] ? ({ data: secrets[name] } as kind.Secret) : null),
    applyConfigMap: (cm) => {
      fake.applied.push(`ConfigMap/${cm.metadata?.name}`);
      return Promise.resolve();
    },
    applyServiceAccount: (sa) => {
      fake.applied.push(`ServiceAccount/${sa.metadata?.name}`);
      return Promise.resolve();
    },
    applyRole: (r) => {
      fake.applied.push(`Role/${r.metadata?.name}`);
      return Promise.resolve();
    },
    applyRoleBinding: (rb) => {
      fake.applied.push(`RoleBinding/${rb.metadata?.name}`);
      return Promise.resolve();
    },
    applyDeployment: (d) => {
      fake.applied.push(`Deployment/${d.metadata?.name}`);
      return Promise.resolve();
    },
    patchIndexerStatus: (_ns, _name, status) => {
      fake.statusPatches.push(status);
      return Promise.resolve();
    },
    listIndexers: () => Promise.resolve([]),
  };
  return fake;
}

describe('reconcile', () => {
  it('happy path: applies 5 resources + Provisioned=True, and is ok', async () => {
    const kube = makeFake();
    expect(await reconcile({ kube, workerImage: 'w:test', log }, makeCr())).toBe('ok');
    expect(kube.applied).toEqual([
      'ServiceAccount/arckive-demo',
      'Role/arckive-demo-status',
      'RoleBinding/arckive-demo-status',
      'ConfigMap/arckive-demo-config',
      'Deployment/arckive-demo',
    ]);
    expect(kube.statusPatches).toHaveLength(1);
    expect(kube.statusPatches[0]!.observedGeneration).toBe(3);
    expect(kube.statusPatches[0]!.conditions?.[0]).toMatchObject({
      type: 'Provisioned',
      status: 'True',
      reason: 'Reconciled',
    });
  });

  it('missing ABI ConfigMap: no apply, Provisioned=False/MissingAbiConfigMap, waiting', async () => {
    const kube = makeFake({ cms: {} });
    expect(await reconcile({ kube, workerImage: 'w:test', log }, makeCr())).toBe('waiting');
    expect(kube.applied).toEqual([]);
    expect(kube.statusPatches[0]!.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'MissingAbiConfigMap',
    });
  });

  it('ABI ConfigMap exists but the key is missing: Provisioned=False', async () => {
    const kube = makeFake({ cms: { 'emitter-abi': { 'other.json': '[]' } } });
    expect(await reconcile({ kube, workerImage: 'w:test', log }, makeCr())).toBe('waiting');
    expect(kube.applied).toEqual([]);
    expect(kube.statusPatches[0]!.conditions?.[0]!.reason).toBe('MissingAbiConfigMap');
  });

  it('missing DSN Secret: Provisioned=False/MissingDsnSecret, waiting', async () => {
    const kube = makeFake({ secrets: {} });
    expect(await reconcile({ kube, workerImage: 'w:test', log }, makeCr())).toBe('waiting');
    expect(kube.applied).toEqual([]);
    expect(kube.statusPatches[0]!.conditions?.[0]!.reason).toBe('MissingDsnSecret');
  });

  it('missing insights header Secret: Provisioned=False/MissingInsightsSecret, waiting', async () => {
    const kube = makeFake();
    const cr = makeCr();
    cr.spec!.insights = { laya: { url: 'https://laya-gate.example', headerSecretRef: { name: 'laya-gate', key: 'header' } } };
    expect(await reconcile({ kube, workerImage: 'w:test', log }, cr)).toBe('waiting');
    expect(kube.applied).toEqual([]);
    expect(kube.statusPatches[0]!.conditions?.[0]!.reason).toBe('MissingInsightsSecret');
  });

  it('insights header Secret present: reconciles', async () => {
    const kube = makeFake({ secrets: { 'pg-dsn': { url: 'ZHNu' }, 'laya-gate': { header: 'eA==' } } });
    const cr = makeCr();
    cr.spec!.insights = { laya: { url: 'https://laya-gate.example', headerSecretRef: { name: 'laya-gate', key: 'header' } } };
    expect(await reconcile({ kube, workerImage: 'w:test', log }, cr)).toBe('ok');
    expect(kube.applied).toHaveLength(5);
  });

  it('invalid spec: Provisioned=False/InvalidSpec, ok (only a spec change, a new generation, fixes it)', async () => {
    const kube = makeFake();
    const cr = makeCr();
    (cr.spec as { contracts: unknown }).contracts = [];
    expect(await reconcile({ kube, workerImage: 'w:test', log }, cr)).toBe('ok');
    expect(kube.applied).toEqual([]);
    expect(kube.statusPatches[0]!.conditions?.[0]!.reason).toBe('InvalidSpec');
  });

  it('does not re-patch when status is already up to date (reconcile storm protection)', async () => {
    const kube = makeFake();
    const cr = makeCr();
    cr.status = {
      observedGeneration: 3,
      conditions: [
        {
          type: 'Provisioned',
          status: 'True',
          reason: 'Reconciled',
          lastTransitionTime: '2026-07-06T00:00:00.000Z',
        },
      ],
    };
    await reconcile({ kube, workerImage: 'w:test', log }, cr);
    expect(kube.applied).toHaveLength(5); // resources are still applied (SSA is idempotent)
    expect(kube.statusPatches).toEqual([]);
  });

  it('re-patches status when the generation changed', async () => {
    const kube = makeFake();
    const cr = makeCr();
    cr.metadata!.generation = 4;
    cr.status = {
      observedGeneration: 3,
      conditions: [
        {
          type: 'Provisioned',
          status: 'True',
          reason: 'Reconciled',
          lastTransitionTime: '2026-07-06T00:00:00.000Z',
        },
      ],
    };
    await reconcile({ kube, workerImage: 'w:test', log }, cr);
    expect(kube.statusPatches).toHaveLength(1);
    expect(kube.statusPatches[0]!.observedGeneration).toBe(4);
  });

  it('does not re-patch the same error condition', async () => {
    const kube = makeFake({ cms: {} });
    const cr = makeCr();
    cr.status = {
      observedGeneration: 3,
      conditions: [
        {
          type: 'Provisioned',
          status: 'False',
          reason: 'MissingAbiConfigMap',
          message: 'ConfigMap emitter-abi/abi.json not found',
          lastTransitionTime: '2026-07-06T00:00:00.000Z',
        },
      ],
    };
    expect(await reconcile({ kube, workerImage: 'w:test', log }, cr)).toBe('waiting');
    expect(kube.statusPatches).toEqual([]);
  });

  it('makes no calls when metadata is missing', async () => {
    const kube = makeFake();
    await reconcile({ kube, workerImage: 'w:test', log }, { metadata: {} } as Indexer);
    expect(kube.applied).toEqual([]);
    expect(kube.statusPatches).toEqual([]);
  });
});
