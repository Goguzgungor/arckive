import { describe, expect, it } from 'vitest';
import type { Indexer } from '../src/kinds.js';
import { ReconcileGate } from '../src/gate.js';

const cr = (generation: number, uid = 'u1', name = 'demo'): Indexer =>
  ({ metadata: { name, namespace: 'default', uid, generation } }) as Indexer;

function recorder(result = true) {
  const seen: Array<number | undefined> = [];
  const gate = new ReconcileGate(async (c) => {
    seen.push(c.metadata?.generation);
    return result;
  });
  return { gate, seen };
}

describe('ReconcileGate', () => {
  it('reconciles ADDED, then skips MODIFIED events that keep the generation (status writes)', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(1), 'MODIFIED');
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1]);
  });

  it('reconciles a MODIFIED event with a new generation (a spec change)', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(2), 'MODIFIED');
    expect(seen).toEqual([1, 2]);
  });

  it('a resync reconciles whatever the generation', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.resync(cr(1));
    expect(seen).toEqual([1, 1]);
  });

  it('DELETED forgets the Indexer; BOOKMARK and ERROR do nothing', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(1), 'DELETED');
    await gate.watch(cr(1), 'BOOKMARK');
    await gate.watch(cr(1), 'ERROR');
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1, 1]);
  });

  it('a failed reconcile is retried on the next event, not at the next resync', async () => {
    const { gate, seen } = recorder(false);
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1, 1]);
  });

  it('runs one reconcile per Indexer at a time and one rerun with the latest object', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const seen: number[] = [];
    let running = 0;
    let most = 0;
    const gate = new ReconcileGate(async (c) => {
      running++;
      most = Math.max(most, running);
      seen.push(c.metadata!.generation!);
      if (seen.length === 1) await blocked;
      running--;
      return true;
    });
    const first = gate.watch(cr(1), 'ADDED');
    const queued = [gate.watch(cr(2), 'MODIFIED'), gate.watch(cr(3), 'MODIFIED'), gate.watch(cr(4), 'MODIFIED')];
    release();
    await Promise.all([first, ...queued]);
    expect(seen).toEqual([1, 4]);
    expect(most).toBe(1);
  });

  it('Indexers do not wait for each other', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const gate = new ReconcileGate(async (c) => {
      seen.push(c.metadata!.uid!);
      if (c.metadata!.uid === 'a') await blocked;
      return true;
    });
    const a = gate.watch(cr(1, 'a', 'a'), 'ADDED');
    await gate.watch(cr(1, 'b', 'b'), 'ADDED');
    expect(seen).toEqual(['a', 'b']);
    release();
    await a;
  });

  it('a stale resync object (generation 2) arriving after generation 3 was reconciled is not reconciled', async () => {
    const { gate, seen } = recorder();
    await gate.watch(cr(3), 'ADDED');
    expect(seen).toEqual([3]);
    // resync with stale generation 2 does not reconcile
    await gate.resync(cr(2));
    expect(seen).toEqual([3]);
    // following MODIFIED with generation 3 is still skipped (map not reset to 2)
    await gate.watch(cr(3), 'MODIFIED');
    expect(seen).toEqual([3]);
  });

  it('while a reconcile of generation 3 runs, a resync with generation 2 does not replace the pending rerun', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const seen: number[] = [];
    const gate = new ReconcileGate(async (c) => {
      seen.push(c.metadata!.generation!);
      if (seen.length === 1) await blocked;
      return true;
    });
    const first = gate.watch(cr(3), 'ADDED');
    // queue a rerun with generation 4
    const gen4 = gate.watch(cr(4), 'MODIFIED');
    // resync with stale generation 2 should not replace the pending gen4
    const gen2 = gate.resync(cr(2));
    release();
    await Promise.all([first, gen4, gen2]);
    // should reconcile generation 3, then pending 4, not 2
    expect(seen).toEqual([3, 4]);
  });

  it('DELETED while a reconcile is running clears pending, so queued rerun does not apply resources', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const seen: number[] = [];
    const gate = new ReconcileGate(async (c) => {
      seen.push(c.metadata!.generation!);
      if (seen.length === 1) await blocked;
      return true;
    });
    const first = gate.watch(cr(1), 'ADDED');
    // queue a rerun
    const queued = gate.watch(cr(2), 'MODIFIED');
    // delete while running
    await gate.watch(cr(2), 'DELETED');
    release();
    await Promise.all([first, queued]);
    // should reconcile generation 1 only, not the pending 2
    expect(seen).toEqual([1]);
  });

  it('a reconcile that throws is treated as failure; the next event reconciles again and no promise rejects', async () => {
    const seen: number[] = [];
    const gate = new ReconcileGate(async (c) => {
      seen.push(c.metadata!.generation!);
      if (seen.length === 1) throw new Error('deliberate throw');
      return true;
    });
    await gate.watch(cr(1), 'ADDED');
    expect(seen).toEqual([1]);
    // next event should retry
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1, 1]);
    // the promises should resolve, not reject
  });
});
