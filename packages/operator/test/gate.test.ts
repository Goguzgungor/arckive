import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Indexer } from '../src/kinds.js';
import { ReconcileGate, type ReconcileResult } from '../src/gate.js';

const cr = (generation: number, uid = 'u1', name = 'demo'): Indexer =>
  ({ metadata: { name, namespace: 'default', uid, generation } }) as Indexer;

function recorder(result: ReconcileResult = 'ok') {
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
    const { gate, seen } = recorder('failed');
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
      return 'ok';
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
      return 'ok';
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
      return 'ok';
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
      return 'ok';
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
      return 'ok';
    });
    await gate.watch(cr(1), 'ADDED');
    expect(seen).toEqual([1]);
    // next event should retry
    await gate.watch(cr(1), 'MODIFIED');
    expect(seen).toEqual([1, 1]);
    // the promises should resolve, not reject
  });
});

describe('ReconcileGate: a reconcile that clears its run in the same step it sees no rerun', () => {
  it('an event scheduled in the microtasks right after a reconcile resolves is not lost', async () => {
    // Sweep the microtask offset: whichever tick the event lands on, it
    // either joins the running reconcile as its rerun or starts a run of its own.
    for (let hops = 0; hops < 16; hops++) {
      const seen: number[] = [];
      const later: Array<Promise<void>> = [];
      const gate: ReconcileGate = new ReconcileGate(async (c) => {
        seen.push(c.metadata!.generation!);
        if (seen.length === 1) {
          let p = Promise.resolve();
          for (let k = 0; k < hops; k++) p = p.then(() => undefined);
          void p.then(() => { later.push(gate.watch(cr(2), 'MODIFIED')); });
        }
        return 'ok';
      });
      await gate.watch(cr(1), 'ADDED');
      await new Promise((r) => setTimeout(r, 0));
      await Promise.all(later);
      expect({ hops, seen }).toEqual({ hops, seen: [1, 2] });
    }
  });
});

describe('ReconcileGate: waiting for a Secret or ConfigMap', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Each reconcile takes the next scripted result ('ok' once they run out).
  function scripted(results: ReconcileResult[]) {
    const seen: Indexer[] = [];
    const gate = new ReconcileGate(async (c) => {
      seen.push(c);
      return results.shift() ?? 'ok';
    });
    return { gate, seen, gens: () => seen.map((c) => c.metadata?.generation) };
  }
  // the operator's own status patch: same generation, newer object
  const patched = (generation: number): Indexer => ({
    ...cr(generation),
    status: { conditions: [{ type: 'Provisioned', status: 'False', reason: 'MissingDsnSecret' }] },
  }) as Indexer;

  it('reruns after 5 s with the latest object seen; ok stops the retries', async () => {
    const { gate, seen } = scripted(['waiting', 'ok']);
    await gate.watch(cr(1), 'ADDED');
    const latest = patched(1);
    await gate.watch(latest, 'MODIFIED'); // dropped: same generation
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(latest);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(seen).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consecutive waits double the delay up to 60 s', async () => {
    const { gate, seen } = scripted(Array<ReconcileResult>(8).fill('waiting'));
    await gate.watch(cr(1), 'ADDED');
    for (const [k, delay] of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(seen).toHaveLength(k + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toHaveLength(k + 2);
    }
  });

  it('DELETED cancels the retry', async () => {
    const { gate, seen } = scripted(['waiting']);
    await gate.watch(cr(1), 'ADDED');
    await gate.watch(cr(1), 'DELETED');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seen).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a newer generation while a retry is pending runs once, now, and supersedes the retry', async () => {
    const { gate, gens } = scripted(['waiting', 'ok']);
    await gate.watch(cr(1), 'ADDED');
    await vi.advanceTimersByTimeAsync(2_000);
    await gate.watch(cr(2), 'MODIFIED');
    expect(gens()).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gens()).toEqual([1, 2]);
  });

  it('a newer event that is still waiting starts the backoff over from 5 s', async () => {
    const { gate, gens } = scripted(['waiting', 'waiting', 'waiting', 'ok']);
    await gate.watch(cr(1), 'ADDED'); // retry due at 5 s
    await vi.advanceTimersByTimeAsync(4_000);
    await gate.watch(cr(2), 'MODIFIED'); // waits again: retry due at 9 s, not 5 s or 14 s
    expect(gens()).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(gens()).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(gens()).toEqual([1, 2, 2]);
  });

  it('status-only MODIFIED events while waiting do not reconcile', async () => {
    const { gate, seen } = scripted(['waiting']);
    await gate.watch(cr(1), 'ADDED');
    for (let i = 0; i < 5; i++) await gate.watch(patched(1), 'MODIFIED');
    expect(seen).toHaveLength(1);
  });

  it('close() clears every pending retry', async () => {
    const { gate, seen } = scripted(['waiting', 'waiting']);
    await gate.watch(cr(1, 'a', 'a'), 'ADDED');
    await gate.watch(cr(1, 'b', 'b'), 'ADDED');
    gate.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seen).toHaveLength(2);
  });
});
