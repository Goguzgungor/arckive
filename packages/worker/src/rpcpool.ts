import type { Logger } from 'pino';
import { HttpRequestError, TimeoutError, createPublicClient, http, webSocket, type PublicClient } from 'viem';
import { Pacer, isRateLimited, type PaceLimits } from './pacer.js';

// The insight loop's RPC reads, ported from Arc Radar's pool
// (radar/radar/rpc.py), which keeps up with Arc mainnet on the same public
// endpoints: calls go out as JSON-RPC batches of up to 20, one request at a
// time, to endpoints tried in config order. Order is priority, not load
// balancing (like ingest's rank: false). An endpoint that rate-limits or
// fails rests while the others carry the load; a call one endpoint will not
// answer — beamrpc refuses blocks older than ~2 h, a lagging node has not
// seen a block yet — is asked of the next one without resting the first.

export const CHUNK = 20;
export const REST_START_MS = 5_000;
export const REST_MAX_MS = 60_000;

// Per endpoint, between requests: four a second to start, as fast as twenty a
// second on an endpoint that takes it, as slow as one per 8 s on one that
// does not (see pacer.ts). A request is one batch of up to CHUNK calls.
export const INSIGHTS_RPC_PACE: PaceLimits = { startMs: 250, minMs: 50, maxMs: 8000 };

export type Call<T> = (client: PublicClient) => Promise<T>;
export type RequestOutcome = 'ok' | 'rate_limited' | 'failed';

export interface PoolEndpoint {
  url: string;
  client: PublicClient;
  shared: boolean; // ingest queries it too (network.rpc)
  chunk: number; // calls per request: CHUNK for http, 1 for ws (no batching)
}

export interface RpcPoolOptions {
  pace: PaceLimits;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (endpoint: number, outcome: RequestOutcome) => void;
  log?: Pick<Logger, 'warn'>;
}

// URLs may carry an API key in the path or query: an endpoint is named by its
// place in the pool and its host only.
export function endpointLabel(index: number, url: string): string {
  try {
    return `${index}:${new URL(url).host}`;
  } catch {
    return `${index}:?`;
  }
}

function walk(err: unknown, test: (e: unknown) => boolean): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    if (test(e)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// viem refuses a response body over its size limit (10 MiB): a batch of busy
// blocks' receipts can pass it, and half the batch will not.
export function isTooLarge(err: unknown): boolean {
  return walk(err, (e) => (e as { name?: unknown }).name === 'ResponseBodyTooLargeError');
}

// The endpoint did not answer at all: a timeout, a dropped connection, an
// HTTP error status. A JSON-RPC error inside a 200 is an answer, not this.
export function isTransportFailure(err: unknown): boolean {
  return walk(err, (e) => (e instanceof HttpRequestError && e.status !== 429) || e instanceof TimeoutError);
}

class Slot {
  failures = 0;
  restUntil = 0;
  constructor(
    readonly index: number,
    readonly label: string,
    readonly client: PublicClient,
    readonly shared: boolean,
    readonly chunk: number,
    readonly pacer: Pacer,
  ) {}
}

export class RpcPool {
  readonly #slots: Slot[];
  readonly #now: () => number;
  readonly #opts: RpcPoolOptions;
  // one all() at a time: two callers never have requests in flight together
  #chain: Promise<unknown> = Promise.resolve();

  constructor(endpoints: readonly PoolEndpoint[], opts: RpcPoolOptions) {
    if (!endpoints.length) throw new Error('RpcPool needs at least one endpoint');
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#slots = endpoints.map(
      (e, i) => new Slot(i, endpointLabel(i, e.url), e.client, e.shared, e.chunk, new Pacer(opts.pace, this.#now, opts.sleep)),
    );
  }

  get endpoints(): ReadonlyArray<{ label: string; chunk: number; shared: boolean }> {
    return this.#slots.map((s) => ({ label: s.label, chunk: s.chunk, shared: s.shared }));
  }

  // Ingest is failing, often on a rate limit it shares with insights: slow
  // down on the endpoints it uses, leave the others alone.
  backOffShared(): void {
    for (const s of this.#slots) if (s.shared) s.pacer.backOff();
  }

  all<T>(calls: readonly Call<T>[]): Promise<PromiseSettledResult<T>[]> {
    const result = this.#chain.then(() => this.#all(calls));
    this.#chain = result.catch(() => undefined);
    return result;
  }

  async #all<T>(calls: readonly Call<T>[]): Promise<PromiseSettledResult<T>[]> {
    const out: PromiseSettledResult<T>[] = new Array(calls.length);
    // chunks are cut to the first endpoint's size; a chunk that falls through
    // to a smaller-chunk endpoint is cut again there (#send)
    const size = this.#slots[0]!.chunk;
    for (let start = 0; start < calls.length; start += size) {
      const idx = Array.from({ length: Math.min(size, calls.length - start) }, (_, k) => start + k);
      await this.#chunk(calls, idx, out);
    }
    return out;
  }

  // The next endpoint for a chunk: the first untried one that is not resting;
  // when every untried one rests, the one whose rest ends first — stalling
  // for a minute over what is usually a one-second blip costs more than one
  // early request (Radar's _order).
  #pick(tried: ReadonlySet<number>): Slot | undefined {
    const now = this.#now();
    const open = this.#slots.filter((s) => !tried.has(s.index));
    return open.find((s) => s.restUntil <= now) ?? [...open].sort((a, b) => a.restUntil - b.restUntil)[0];
  }

  async #chunk<T>(calls: readonly Call<T>[], idx: number[], out: PromiseSettledResult<T>[]): Promise<void> {
    const lastError = new Map<number, unknown>();
    const tried = new Set<number>();
    let pending = idx;
    while (pending.length) {
      const slot = this.#pick(tried);
      if (!slot) break;
      tried.add(slot.index);
      const left: number[] = [];
      for (let k = 0; k < pending.length; k += slot.chunk) {
        left.push(...(await this.#send(slot, calls, pending.slice(k, k + slot.chunk), out, lastError)));
      }
      pending = left;
    }
    for (const i of pending) out[i] = { status: 'rejected', reason: lastError.get(i) ?? new Error('no endpoint answered') };
  }

  // One request to one endpoint; returns the calls it did not answer.
  async #send<T>(
    slot: Slot, calls: readonly Call<T>[], idx: number[], out: PromiseSettledResult<T>[], lastError: Map<number, unknown>,
  ): Promise<number[]> {
    // started in one tick, so viem's batch scheduler sends them as one array
    const settled = await slot.pacer.run(() => Promise.allSettled(idx.map((i) => calls[i]!(slot.client))));
    let rateLimited = false;
    let transport = false;
    const failed: number[] = [];
    const big: number[] = [];
    settled.forEach((r, k) => {
      const i = idx[k]!;
      if (r.status === 'fulfilled') {
        out[i] = r;
        return;
      }
      lastError.set(i, r.reason);
      if (isRateLimited(r.reason)) rateLimited = true;
      else if (isTooLarge(r.reason)) {
        big.push(i);
        return;
      } else if (isTransportFailure(r.reason)) transport = true;
      failed.push(i);
    });
    this.#opts.onRequest?.(slot.index, rateLimited ? 'rate_limited' : failed.length || big.length ? 'failed' : 'ok');
    if (rateLimited) {
      slot.pacer.backOff();
      this.#rest(slot, 'rate limited');
    } else if (transport) {
      this.#rest(slot, 'failed');
    } else {
      slot.failures = 0;
      slot.restUntil = 0;
    }
    if (!big.length) return failed;
    // too large: no endpoint does better with the same batch, so halve it here
    if (big.length === 1) {
      out[big[0]!] = { status: 'rejected', reason: lastError.get(big[0]!) };
      return failed;
    }
    const half = Math.ceil(big.length / 2);
    return [
      ...failed,
      ...(await this.#send(slot, calls, big.slice(0, half), out, lastError)),
      ...(await this.#send(slot, calls, big.slice(half), out, lastError)),
    ];
  }

  #rest(slot: Slot, why: string): void {
    slot.failures++;
    const restMs = Math.min(REST_START_MS * 2 ** (slot.failures - 1), REST_MAX_MS);
    slot.restUntil = this.#now() + restMs;
    this.#opts.log?.warn({ endpoint: slot.label, why, restMs }, 'insights rpc endpoint resting');
  }
}

const sameUrl = (u: string) => u.replace(/\/+$/, '').toLowerCase();

// No transport retries and no fallback: a rate limit or a failure has to
// reach the pool (and the pacer) to move the call on and slow down.
export function createRpcPool(urls: readonly string[], ingestUrls: readonly string[], opts: RpcPoolOptions): RpcPool {
  const ingest = new Set(ingestUrls.map(sameUrl));
  return new RpcPool(
    urls.map((url) => {
      const ws = /^wss?:\/\//i.test(url);
      const transport = ws
        ? webSocket(url, { timeout: 10_000, retryCount: 0 })
        : http(url, { batch: { batchSize: CHUNK }, timeout: 10_000, retryCount: 0 });
      return { url, client: createPublicClient({ transport }), shared: ingest.has(sameUrl(url)), chunk: ws ? 1 : CHUNK };
    }),
    opts,
  );
}

async function probeChainId(url: string): Promise<number> {
  const transport = /^wss?:\/\//i.test(url)
    ? webSocket(url, { timeout: 5_000, retryCount: 0 })
    : http(url, { timeout: 5_000, retryCount: 0 });
  return createPublicClient({ transport }).getChainId();
}

// An endpoint on another chain would answer every call — with another chain's
// blocks, and wrong lanes. One that does not answer may come back; it stays
// and rests until it does.
export async function checkPoolChain(
  urls: readonly string[], chainId: number, log: Pick<Logger, 'error'>,
  probe: (url: string) => Promise<number> = probeChainId,
): Promise<string[]> {
  const kept: string[] = [];
  for (const [i, url] of urls.entries()) {
    const got = await probe(url).catch(() => null);
    if (got !== null && got !== chainId) {
      log.error({ endpoint: endpointLabel(i, url), chainId: got, expected: chainId }, 'insights rpc endpoint is on another chain — dropped');
      continue;
    }
    kept.push(url);
  }
  return kept;
}
