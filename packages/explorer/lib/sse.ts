// Server-Sent Events framing. JSON.stringify never emits a raw newline, so
// each payload is one data line.
export function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A comment line every 15 s keeps proxies (Cloudflare closes after 100 s idle) from cutting the stream.
export const HEARTBEAT = ': hb\n\n';
export const RETRY = 'retry: 3000\n\n';

// The browser resends the last id as a header on its own reconnects; the
// client's own reconnects (after a 503) pass it as ?last=.
export function parseLastEventId(header: string | null, query: string | null): number | null {
  const v = (header ?? query ?? '').trim();
  return /^\d{1,15}$/.test(v) ? Number(v) : null;
}
