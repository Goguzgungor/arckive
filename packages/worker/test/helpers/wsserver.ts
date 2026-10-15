import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeWsServer {
  url: string;
  /** every connection the client opened, in arrival order */
  conns: WebSocket[];
  stop: () => Promise<void>;
}

// A WebSocket endpoint that answers eth_subscribe however the test says, so
// the client can be fed what anvil never sends: frames that are not JSON,
// an error reply to the subscription, or silence.
export async function startFakeWs(
  onConnect: (sock: WebSocket, n: number) => void,
): Promise<FakeWsServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as { port: number };
  const conns: WebSocket[] = [];
  wss.on('connection', (sock) => {
    conns.push(sock);
    onConnect(sock, conns.length);
  });
  return {
    url: `ws://127.0.0.1:${port}`,
    conns,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

/** Acknowledges eth_subscribe with subscription id 0x1, then calls `then`. */
export function acceptSubscribe(sock: WebSocket, then?: () => void): void {
  sock.on('message', (data) => {
    const m = JSON.parse(String(data)) as { id?: number; method?: string };
    if (m.method !== 'eth_subscribe') return;
    sock.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: '0x1' }));
    then?.();
  });
}

/** One newHeads notification for block `n`, timestamped now. */
export function headFrame(n: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_subscription',
    params: {
      subscription: '0x1',
      result: {
        number: `0x${n.toString(16)}`,
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
      },
    },
  });
}
