import type { kind } from 'kubernetes-fluent-client';
import type { IndexerStatus } from '@arckive/core';
import type { Indexer } from './kinds.js';
import { KubeHttpError, type KubeHttp } from './kubehttp.js';

export interface KubeApi {
  getConfigMap(namespace: string, name: string): Promise<kind.ConfigMap | null>;
  getSecret(namespace: string, name: string): Promise<kind.Secret | null>;
  applyConfigMap(cm: kind.ConfigMap): Promise<void>;
  applyServiceAccount(sa: kind.ServiceAccount): Promise<void>;
  applyRole(role: kind.Role): Promise<void>;
  applyRoleBinding(rb: kind.RoleBinding): Promise<void>;
  applyDeployment(d: kind.Deployment): Promise<void>;
  patchIndexerStatus(namespace: string, name: string, status: IndexerStatus): Promise<void>;
  listIndexers(): Promise<Indexer[]>;
}

// Server-side apply's field manager, kept as "pepr": the name
// kubernetes-fluent-client applied with. Managers that apply the same value
// share ownership, so a different name would leave "pepr" co-owning every
// field of objects applied before this client existed, and a field later
// removed from the desired state (the INSIGHTS_HEADER env, ABI volumes)
// would never be deleted. Same name = no ownership migration.
const FIELD_MANAGER = 'pepr';

const PLURAL: Readonly<Record<string, string>> = {
  ConfigMap: 'configmaps', Secret: 'secrets', ServiceAccount: 'serviceaccounts',
  Role: 'roles', RoleBinding: 'rolebindings', Deployment: 'deployments', Indexer: 'indexers',
};

export function objectPath(apiVersion: string, kindName: string, namespace: string, name?: string): string {
  const plural = PLURAL[kindName];
  if (!plural) throw new Error(`no API path for kind ${kindName}`);
  const base = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
  const ns = encodeURIComponent(namespace);
  return `${base}/namespaces/${ns}/${plural}${name ? `/${encodeURIComponent(name)}` : ''}`;
}

interface Applicable {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
}

export function createKubeApi(http: KubeHttp): KubeApi {
  const apply = async (obj: Applicable): Promise<void> => {
    const { apiVersion, kind: kindName, metadata } = obj;
    if (!apiVersion || !kindName || !metadata?.name || !metadata.namespace) {
      throw new Error('apply needs apiVersion, kind, metadata.name and metadata.namespace');
    }
    // JSON is YAML: the apply-patch content type takes it as is
    await http.patch(
      `${objectPath(apiVersion, kindName, metadata.namespace, metadata.name)}?fieldManager=${FIELD_MANAGER}&fieldValidation=Strict&force=true`,
      'application/apply-patch+yaml',
      obj,
    );
  };
  return {
    getConfigMap: async (ns, name) => (await http.get(objectPath('v1', 'ConfigMap', ns, name))) as kind.ConfigMap | null,
    getSecret: async (ns, name) => (await http.get(objectPath('v1', 'Secret', ns, name))) as kind.Secret | null,
    applyConfigMap: apply,
    applyServiceAccount: apply,
    applyRole: apply,
    applyRoleBinding: apply,
    applyDeployment: apply,
    async patchIndexerStatus(namespace, name, status) {
      // a merge patch of the status subresource, as before
      await http.patch(
        `${objectPath('arckive.org/v1alpha1', 'Indexer', namespace, name)}/status`,
        'application/merge-patch+json',
        { status },
      );
    },
    async listIndexers() {
      const path = '/apis/arckive.org/v1alpha1/indexers';
      const list = (await http.get(path)) as { items?: Indexer[] } | null;
      // a 404 here means the CRD is missing: say so rather than list nothing
      if (list === null) throw new KubeHttpError('GET', path, 404, '');
      return list.items ?? [];
    },
  };
}
