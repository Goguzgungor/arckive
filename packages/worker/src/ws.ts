import type { Logger } from 'pino';

export interface HeadPayload {
  number: bigint;
  timestamp: Date;
}

export interface NewHeadsSubscription {
  close(): void;
}

// What a JSON-RPC frame may carry; every field is checked before use.
interface HeadFields {
  number?: unknown;
  timestamp?: unknown;
}
interface Frame {
  id?: unknown;
  error?: unknown;
  method?: unknown;
  params?: { result?: HeadFields };
}

// Only a JSON text frame can be a JSON-RPC message. Anything else — a proxy's
// HTML error page, a binary frame, a bare keepalive string — yields null here
// instead of a throw: an exception inside a WebSocket listener surfaces as an
// uncaughtException, which the worker does not handle, and one bad frame
// must not end the process.
function parseFrame(data: unknown): Frame | null {
  if (typeof data !== 'string') return null;
  try {
    const v: unknown = JSON.parse(data);
    return v !== null && typeof v === 'object' ? (v as Frame) : null;
  } catch {
    return null;
  }
}

// A head payload, or null — a wake-up without a target — when the
// notification does not carry a readable block number and timestamp.
// (`BigInt('0xzz')` throws like JSON.parse does, so the same guard applies.)
function toHead(r: HeadFields | undefined): HeadPayload | null {
  if (typeof r?.number !== 'string' || typeof r.timestamp !== 'string') return null;
  try {
    return { number: BigInt(r.number), timestamp: new Date(Number(r.timestamp) * 1000) };
  } catch {
    return null;
  }
}

// PARALLEL newHeads subscription to all ws endpoints (fan-in): the primary
// (first in the list) endpoint feeds the hot-path target, the others provide
// wake-ups and redundancy. Each connection reconnects to the same endpoint
// with its own backoff. A raw WebSocket is used because the viem transport
// does not expose connection state.
export function subscribeNewHeads(opts: {
  wsUrls: string[];
  onHead: (head: HeadPayload | null, primary: boolean) => void;
  onStateChange: (connected: boolean) => void; // is at least one endpoint connected
  log: Logger;
  // A connection with no frame for this long is dropped and reopened. A
  // half-open TCP session (a NAT or load balancer that dropped it without a
  // FIN) never fires `close`, and the raw WebSocket has no ping API, so
  // silence is the only sign. Arc announces a head about every second: a
  // minute without one is a dead socket, not a quiet chain.
  idleMs?: number;
}): NewHeadsSubscription {
  const idleMs = opts.idleMs ?? 60_000;
  let closed = false;
  const connected = new Set<number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const socks = new Set<WebSocket>();

  const setConn = (idx: number, up: boolean): void => {
    const before = connected.size > 0;
    if (up) connected.add(idx);
    else connected.delete(idx);
    const after = connected.size > 0;
    if (before !== after) opts.onStateChange(after);
  };

  const connect = (idx: number, attempt: number): void => {
    if (closed) return;
    const url = opts.wsUrls[idx]!;
    const sock = new WebSocket(url);
    socks.add(sock);
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    // Ends this connection exactly once — whether the peer closed it, the
    // endpoint refused the subscription or the watchdog gave up on it — and
    // schedules the reconnect. The watchdog cannot wait for a close event (a
    // half-open socket never sends one), so the handlers are detached and the
    // socket abandoned; a late `close` then finds nothing to run.
    const finish = (msg: string, extra: Record<string, unknown> = {}): void => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      socks.delete(sock);
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      sock.close();
      if (closed) return;
      setConn(idx, false);
      const delayMs = Math.min(1_000 * 2 ** attempt, 30_000);
      opts.log.warn({ url, delayMs, ...extra }, msg);
      const t = setTimeout(() => {
        timers.delete(t);
        connect(idx, attempt + 1);
      }, delayMs);
      timers.add(t);
    };
    const touch = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => finish('WS silent — reconnecting', { idleMs }), idleMs);
    };

    sock.onopen = () => {
      touch();
      sock.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }),
      );
    };
    sock.onmessage = (ev) => {
      touch();
      const msg = parseFrame(ev.data);
      if (!msg) {
        opts.log.warn({ url }, 'ignoring a WS frame that is not JSON-RPC');
        return;
      }
      if (msg.id === 1) {
        // The reply to eth_subscribe. An error reply (subscriptions disabled,
        // a token demanded) is no subscription: the socket would stay open and
        // never deliver a head while ws_connected claimed otherwise, so it is
        // treated as a dropped connection and retried with backoff.
        if (msg.error) {
          finish('newHeads subscription refused', { error: msg.error });
          return;
        }
        attempt = 0;
        setConn(idx, true);
        opts.log.info({ url }, 'newHeads subscription opened');
      } else if (msg.method === 'eth_subscription') {
        opts.onHead(toHead(msg.params?.result), idx === 0);
      }
    };
    sock.onclose = () => finish('WS dropped — reconnecting');
    sock.onerror = () => {
      // an error is always followed by close; onclose handles the reconnect
    };
  };

  opts.wsUrls.forEach((_, i) => connect(i, 0));
  return {
    close(): void {
      closed = true;
      for (const t of timers) clearTimeout(t);
      for (const s of socks) s.close();
    },
  };
}
