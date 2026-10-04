import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const path = fileURLToPath(
  new URL('../../../charts/arckive/crds/indexer.yaml', import.meta.url),
);

interface CrdDoc {
  metadata: { name: string };
  spec: {
    group: string;
    scope: string;
    names: { kind: string; plural: string; shortNames?: string[] };
    versions: Array<{
      name: string;
      subresources?: { status?: object };
      additionalPrinterColumns?: Array<{ name: string; jsonPath: string; type: string }>;
      schema: { openAPIV3Schema: { properties: { spec: { properties: Record<string, unknown> } } } };
    }>;
  };
}

describe('Indexer CRD manifest', () => {
  const crd = load(readFileSync(path, 'utf8')) as CrdDoc;
  const v = crd.spec.versions[0]!;

  it('GVK and scope are correct', () => {
    expect(crd.metadata.name).toBe('indexers.arckive.org');
    expect(crd.spec.group).toBe('arckive.org');
    expect(crd.spec.scope).toBe('Namespaced');
    expect(crd.spec.names).toMatchObject({ kind: 'Indexer', plural: 'indexers' });
    expect(v.name).toBe('v1alpha1');
  });

  it('status subresource is enabled', () => {
    expect(v.subresources?.status).toBeDefined();
  });

  it('printer columns are PHASE/CURRENT/HEAD/LAG', () => {
    expect(v.additionalPrinterColumns?.map((c) => [c.name, c.jsonPath])).toEqual([
      ['Phase', '.status.phase'],
      ['Current', '.status.currentBlock'],
      ['Head', '.status.headBlock'],
      ['Lag', '.status.lag'],
    ]);
  });

  it('spec schema defines the same top-level fields as zod', () => {
    expect(Object.keys(v.schema.openAPIV3Schema.properties.spec.properties).sort()).toEqual(
      ['contracts', 'insights', 'network', 'polling', 'storage'],
    );
  });
});
