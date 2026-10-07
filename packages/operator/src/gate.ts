import type { Indexer } from './kinds.js';

// Decides which watch events cost a reconcile, and runs at most one reconcile
// per Indexer at a time.
//
// Every worker patches its Indexer's .status every 10 s, and each patch is a
// watch event. Reconciling them all cost ~8 API requests per Indexer every
// 10 s for nothing — status never changes what the operator renders — and
// was one reconcile every 3.3 s with three Indexers when the operator was
// OOMKilled. Status writes do not bump metadata.generation on a CRD with the
// status subresource; spec changes do.
export type ReconcileFn = (cr: Indexer) => Promise<boolean>; // false: it failed

export class ReconcileGate {
  // key -> generation last reconciled, or queued to be
  readonly #generation = new Map<string, number | undefined>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, Indexer>();

  constructor(private readonly reconcile: ReconcileFn) {}

  watch(cr: Indexer, phase: string): Promise<void> {
    const key = keyOf(cr);
    if (!key) return Promise.resolve();
    if (phase === 'DELETED') {
      this.#generation.delete(key);
      this.#pending.delete(key);
      return Promise.resolve();
    }
    if (phase === 'MODIFIED' && this.#generation.has(key) && this.#generation.get(key) === cr.metadata?.generation) {
      return Promise.resolve();
    }
    if (phase !== 'ADDED' && phase !== 'MODIFIED') return Promise.resolve(); // BOOKMARK, ERROR
    return this.#schedule(key, cr);
  }

  // The periodic resync reconciles whatever the generation: it is how a
  // Secret or ConfigMap created after its Indexer is noticed.
  resync(cr: Indexer): Promise<void> {
    const key = keyOf(cr);
    return key ? this.#schedule(key, cr) : Promise.resolve();
  }

  #schedule(key: string, cr: Indexer): Promise<void> {
    const incomingGen = cr.metadata?.generation;
    const recordedGen = this.#generation.get(key);

    // Never reconcile a stale generation: resync may list an old object,
    // and watch events for the spec can arrive out of order. A stale
    // generation would overwrite newer desired state. Undefined generations
    // are not comparable, so allow them through (watch events on CRs without
    // metadata.generation, or resync objects that might be cached).
    if (
      incomingGen !== undefined &&
      recordedGen !== undefined &&
      incomingGen < recordedGen
    ) {
      const running = this.#running.get(key);
      return running ? running : Promise.resolve();
    }

    // Update recorded generation to allow higher generations (or equal on
    // resync to notice Secrets/ConfigMaps created after the Indexer).
    this.#generation.set(key, incomingGen);
    const running = this.#running.get(key);
    if (running) {
      // one rerun after the current reconcile, with the latest object;
      // replace only if the new object's generation is >= the pending one
      const pendingGen = this.#pending.get(key)?.metadata?.generation;
      if (pendingGen === undefined || incomingGen === undefined || incomingGen >= pendingGen) {
        this.#pending.set(key, cr);
      }
      return running;
    }
    const run = (async () => {
      let next: Indexer | undefined = cr;
      while (next) {
        const generation = next.metadata?.generation;
        let ok = false;
        try {
          ok = await this.reconcile(next);
        } catch {
          // A throw is treated as reconcile failure, and exception safety
          // requires we clear #running in the finally.
          ok = false;
        }
        // A failed reconcile forgets its generation, so the next event for
        // this Indexer tries again instead of waiting for the resync.
        if (!ok && this.#generation.get(key) === generation) this.#generation.delete(key);
        next = this.#pending.get(key);
        this.#pending.delete(key);
      }
    })();
    this.#running.set(key, run.finally(() => this.#running.delete(key)));
    return this.#running.get(key)!;
  }
}

function keyOf(cr: Indexer): string | undefined {
  const m = cr.metadata;
  return m?.uid ?? (m?.name ? `${m.namespace ?? ''}/${m.name}` : undefined);
}
