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
//
// 'waiting': the reconcile found a Secret or ConfigMap missing (reconcile.ts).
// 'failed': it threw (or the operator's wrapper caught a throw).
export type ReconcileResult = 'ok' | 'waiting' | 'failed';
export type ReconcileFn = (cr: Indexer) => Promise<ReconcileResult>;

// A waiting Indexer is asked again after 5 s, doubling per consecutive wait
// up to a minute; the periodic resync still covers anything longer.
export const WAIT_RETRY_START_MS = 5_000;
export const WAIT_RETRY_MAX_MS = 60_000;

export class ReconcileGate {
  // key -> generation last reconciled, or queued to be
  readonly #generation = new Map<string, number | undefined>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, Indexer>();
  // key -> the newest object any event carried, status-only ones included. A
  // retry reconciles this one, so it compares against the status the last
  // reconcile wrote and does not patch the same condition again.
  readonly #latest = new Map<string, Indexer>();
  readonly #retry = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #retryDelay = new Map<string, number>(); // the next wait's delay
  #closed = false;

  constructor(private readonly reconcile: ReconcileFn) {}

  watch(cr: Indexer, phase: string): Promise<void> {
    const key = keyOf(cr);
    if (!key) return Promise.resolve();
    if (phase === 'DELETED') {
      this.#generation.delete(key);
      this.#pending.delete(key);
      this.#latest.delete(key);
      this.#clearRetry(key);
      return Promise.resolve();
    }
    if (phase !== 'ADDED' && phase !== 'MODIFIED') return Promise.resolve(); // BOOKMARK, ERROR
    this.#remember(key, cr);
    if (phase === 'MODIFIED' && this.#generation.has(key) && this.#generation.get(key) === cr.metadata?.generation) {
      return Promise.resolve();
    }
    return this.#schedule(key, cr, false);
  }

  // The periodic resync reconciles whatever the generation: it is how a
  // Secret or ConfigMap that stays missing past the waiting retries' minute
  // spacing, or an Indexer whose reconcile failed with no event since, is
  // picked up in the end.
  resync(cr: Indexer): Promise<void> {
    const key = keyOf(cr);
    if (!key) return Promise.resolve();
    this.#remember(key, cr);
    return this.#schedule(key, cr, false);
  }

  // Operator shutdown: no retry fires, or is set, after this.
  close(): void {
    this.#closed = true;
    for (const key of [...this.#retry.keys()]) this.#clearRetry(key);
  }

  #remember(key: string, cr: Indexer): void {
    const incoming = cr.metadata?.generation;
    const known = this.#latest.get(key)?.metadata?.generation;
    if (incoming === undefined || known === undefined || incoming >= known) this.#latest.set(key, cr);
  }

  #clearRetry(key: string): void {
    clearTimeout(this.#retry.get(key));
    this.#retry.delete(key);
    this.#retryDelay.delete(key);
  }

  // The generation is kept while waiting, so the worker's and the operator's
  // own status events still cost nothing. But creating the missing Secret or
  // ConfigMap is no event on the Indexer at all, and manifests are often
  // applied Indexer first: without this timer it would wait for the resync
  // (5 min by default) — as long as the kind e2e waits for Live.
  #retryLater(key: string): void {
    if (this.#closed || !this.#latest.has(key)) return; // shut down, or DELETED meanwhile
    const delay = this.#retryDelay.get(key) ?? WAIT_RETRY_START_MS;
    this.#retryDelay.set(key, Math.min(delay * 2, WAIT_RETRY_MAX_MS));
    const timer = setTimeout(() => {
      this.#retry.delete(key);
      const latest = this.#latest.get(key);
      if (latest) void this.#schedule(key, latest, true);
    }, delay);
    timer.unref(); // a pending retry never keeps the process alive
    this.#retry.set(key, timer);
  }

  #schedule(key: string, cr: Indexer, isRetry: boolean): Promise<void> {
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

    // An event that reconciles anyway supersedes a pending retry, and if it
    // waits too, its backoff starts over: it is a new look at the Indexer,
    // not the same wait again.
    if (!isRetry) this.#clearRetry(key);

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
    const run: Promise<void> = this.#drain(key, cr, () => run);
    this.#running.set(key, run);
    return run;
  }

  // One run: the reconcile, then the queued rerun if any, until none is
  // queued. `self` is this run's own promise, its #running entry.
  async #drain(key: string, first: Indexer, self: () => Promise<void>): Promise<void> {
    // #running is set (by #schedule) before the first reconcile starts, so a
    // schedule that lands while it runs joins it as #pending
    await null;
    let next: Indexer = first;
    for (;;) {
      const generation = next.metadata?.generation;
      let result: ReconcileResult;
      try {
        result = await this.reconcile(next);
      } catch {
        // A throw counts as a failed reconcile; the loop must still reach
        // the #running cleanup below.
        result = 'failed';
      }
      // A failed reconcile forgets its generation, so the next event for
      // this Indexer tries again instead of waiting for the resync.
      if (result === 'failed' && this.#generation.get(key) === generation) this.#generation.delete(key);
      const queued = this.#pending.get(key);
      if (!queued) {
        // Cleared in the same synchronous step that found no rerun queued:
        // a schedule before this point was drained above, one after it
        // starts a run of its own. (Deleting in a .finally left a few
        // microtasks in which a schedule joined a run that had already
        // ended, and its event was lost.) The identity check never removes
        // a later run's entry.
        if (this.#running.get(key) === self()) this.#running.delete(key);
        if (result === 'waiting') this.#retryLater(key);
        else if (result === 'ok') this.#clearRetry(key);
        return;
      }
      this.#pending.delete(key);
      next = queued;
    }
  }
}

function keyOf(cr: Indexer): string | undefined {
  const m = cr.metadata;
  return m?.uid ?? (m?.name ? `${m.namespace ?? ''}/${m.name}` : undefined);
}
