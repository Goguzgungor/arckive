import { z } from 'zod';
import { LANE_QUESTION, type LaneAnswer } from '@arckive/core';

// Client for a Laya model gate (radar/radar/modelgate.py in front of layad):
// POST /ai/run/batch answers one question for many sentences, GET /health
// names the model. The gate is shared with live radars and allows 240 calls a
// minute across everyone, so this client stays well inside that on its own.

export class LayaError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LayaError';
    this.status = status;
  }
}

export interface HeaderLine {
  name: string;
  value: string;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Printable ASCII, space and tab. A newline would make a second header (and
// fetch quotes an invalid value verbatim in its error, which would then be
// logged on every retry); anything above ASCII fails on every call.
const VALUE = /^[\t\x20-\x7e]*$/;

// INSIGHTS_HEADER is a whole header line, "Name: value". The value is a
// secret: no error here repeats any of the line.
export function parseHeaderLine(line: string): HeaderLine {
  const i = line.indexOf(':');
  const name = i > 0 ? line.slice(0, i).trim() : '';
  const value = line.slice(i + 1).trim();
  if (!name || !TOKEN.test(name) || !VALUE.test(value)) {
    throw new LayaError('INSIGHTS_HEADER must be one header line, "Name: value", in printable ASCII');
  }
  return { name, value };
}

const BatchResponse = z.object({
  results: z.array(
    z.object({
      answers: z.object({
        lane: z.object({ choice: z.string(), probabilities: z.record(z.number()) }),
      }),
    }),
  ),
});

// A large batch holds the shared GPU for seconds and starves the radars on it
// (radar/radar/server.py BATCH_MAX).
export const BATCH_MAX = 64;
// One call a second at most: a quarter of the gate's shared budget.
export const MIN_CALL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 30_000;
const CACHE_MAX = 60_000;

export interface LayaDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onCall?: () => void;
  onCacheHits?: (n: number) => void;
}

export class LayaClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  // Real traffic repeats a handful of shapes thousands of times; answers are
  // kept per exact sentence (the question never changes), least recent first.
  private readonly cache = new Map<string, LaneAnswer>();
  private lastCallAt = -Infinity;
  private readonly deps: LayaDeps;

  constructor(url: string, header: HeaderLine | null, deps: LayaDeps = {}) {
    this.base = url.replace(/\/+$/, '');
    // Cloudflare in front of the tunnel refuses some clients by their default
    // User-Agent before the request reaches the gate.
    this.headers = { 'user-agent': 'arckive-worker', ...(header ? { [header.name]: header.value } : {}) };
    this.deps = deps;
  }

  async classify(sentences: string[]): Promise<Map<string, LaneAnswer>> {
    const out = new Map<string, LaneAnswer>();
    const unseen: string[] = [];
    for (const s of new Set(sentences)) {
      const hit = this.cache.get(s);
      if (hit) {
        this.cache.delete(s);
        this.cache.set(s, hit);
        out.set(s, hit);
      } else {
        unseen.push(s);
      }
    }
    if (out.size) this.deps.onCacheHits?.(out.size);
    for (let i = 0; i < unseen.length; i += BATCH_MAX) {
      const chunk = unseen.slice(i, i + BATCH_MAX);
      const answers = await this.ask(chunk);
      chunk.forEach((s, j) => {
        out.set(s, answers[j]!);
        this.cache.set(s, answers[j]!);
      });
    }
    // Trimmed after the round is answered, so nothing this round needs is evicted first.
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  async identity(): Promise<string | null> {
    try {
      const body = (await this.request('/health', { headers: this.headers })) as { model?: unknown } | null;
      return typeof body?.model === 'string' ? body.model : null;
    } catch {
      return null;
    }
  }

  private async ask(states: string[]): Promise<LaneAnswer[]> {
    await this.pace();
    this.deps.onCall?.();
    const body = await this.request('/ai/run/batch', {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ states, questions: { lane: LANE_QUESTION } }),
    });
    const parsed = BatchResponse.safeParse(body);
    if (!parsed.success || parsed.data.results.length !== states.length) {
      throw new LayaError('gate answered an unexpected body');
    }
    return parsed.data.results.map((r) => r.answers.lane);
  }

  private async pace(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = this.lastCallAt + MIN_CALL_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = now();
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      // Only the error's name and code: fetch's own message can quote the
      // request's headers, and this error is logged on every retry.
      const code = (cause as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code
        ?? (cause as { code?: unknown } | null)?.code;
      const name = cause instanceof Error ? cause.name : typeof cause;
      throw new LayaError(`gate unreachable (${name}${typeof code === 'string' ? ` ${code}` : ''})`);
    }
    if (!res.ok) throw new LayaError(`gate answered HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch (cause) {
      throw new LayaError('gate answered a body that is not JSON', undefined, { cause });
    }
  }
}
