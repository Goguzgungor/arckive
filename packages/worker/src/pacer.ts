import { BaseError, HttpRequestError, LimitExceededRpcError } from 'viem';

// Runs calls one at a time, their starts at least `intervalMs` apart, and
// finds the pace an endpoint will take.
//
// The insight loop shares RPC rate limits with ingest. Arc mainnet's public
// RPC enforces a per-minute quota that ingest polling once a second already
// comes close to — a run without insights still hit "rate limit exceeded" in
// bursts once a minute — while a paid or second endpoint may take many times
// that. So the pace adapts: it halves whenever the endpoint says it is rate
// limited (or ingest is failing, see insights.ts), and creeps back up with
// every call that goes through. Never a burst, and never more than one call
// in flight.

export interface PaceLimits {
  startMs: number;
  minMs: number; // fastest: one call per minMs
  maxMs: number; // slowest it backs off to
}

// Each call that goes through shortens the interval by 3%: from the slowest
// pace back to the start in about a hundred calls.
const RELAX = 0.97;

// -32005 (limit exceeded) or HTTP 429, anywhere in viem's error chain.
export function isRateLimited(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return (
    err.walk((e) => e instanceof LimitExceededRpcError || (e instanceof HttpRequestError && e.status === 429)) !== null
  );
}

export class Pacer {
  #interval: number;
  #next = 0;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly limits: PaceLimits,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.#interval = limits.startMs;
  }

  get intervalMs(): number {
    return this.#interval;
  }

  backOff(): void {
    this.#interval = Math.min(this.limits.maxMs, this.#interval * 2);
    this.#next = this.now() + this.#interval;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(async () => {
      const wait = this.#next - this.now();
      if (wait > 0) await this.sleep(wait);
      this.#next = this.now() + this.#interval;
      try {
        const value = await fn();
        this.#interval = Math.max(this.limits.minMs, this.#interval * RELAX);
        return value;
      } catch (err) {
        if (isRateLimited(err)) this.backOff();
        throw err;
      }
    });
    // the queue moves on whether this call succeeded or not
    this.#chain = result.catch(() => undefined);
    return result;
  }
}
