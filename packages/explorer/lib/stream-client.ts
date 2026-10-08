import type { BlockMsg, Hello, StatsMsg } from './types.js';

export interface StreamHandlers {
  hello(h: Hello): void;
  block(b: BlockMsg): void;
  stats(s: StatsMsg): void;
  state(open: boolean): void;
}

// The parts of EventSource the client uses (injected in tests).
export interface SourceLike {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void;
  close(): void;
}

export interface StreamOptions {
  url?: string;
  watchdogMs?: number;
  makeSource?: (url: string) => SourceLike;
  random?: () => number;
}

const CLOSED = 2;

// For a stream the browser gave up on (a 503 above MAX_STREAMS, a dropped
// connection): 1 s doubling to 30 s, jittered so a restart does not bring
// every viewer back in the same second.
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function openStream(h: StreamHandlers, o: StreamOptions = {}): () => void {
  const url = o.url ?? '/api/stream';
  const make = o.makeSource ?? ((u: string) => new EventSource(u) as unknown as SourceLike);
  const watchdogMs = o.watchdogMs ?? 45_000;
  let source: SourceLike | null = null;
  let last: string | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let dog: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    clearTimeout(retry);
    retry = setTimeout(connect, backoffMs(attempt++, o.random));
  };
  // stats arrive every second: this much silence is a stalled stream (a
  // proxy that stopped forwarding, a server that dropped us as too slow)
  const arm = (): void => {
    clearTimeout(dog);
    dog = setTimeout(() => {
      source?.close();
      source = null;
      h.state(false);
      schedule();
    }, watchdogMs);
  };
  function connect(): void {
    if (stopped) return;
    const s = make(last === null ? url : `${url}?last=${encodeURIComponent(last)}`);
    source = s;
    s.onopen = () => {
      attempt = 0;
      h.state(true);
      arm();
    };
    s.onerror = () => {
      h.state(false);
      // CONNECTING: the browser retries on its own, sending Last-Event-ID
      if (s.readyState === CLOSED && source === s) {
        clearTimeout(dog);
        source = null;
        schedule();
      }
    };
    const on = <T>(type: string, fn: (d: T) => void): void => {
      s.addEventListener(type, (e) => {
        arm();
        if (e.lastEventId) last = e.lastEventId;
        fn(JSON.parse(e.data) as T);
      });
    };
    on<Hello>('hello', h.hello);
    on<BlockMsg>('block', h.block);
    on<StatsMsg>('stats', h.stats);
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(dog);
    source?.close();
    source = null;
  };
}
