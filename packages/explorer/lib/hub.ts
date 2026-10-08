import { HEARTBEAT, RETRY, frame } from './sse.js';
import type { BlockMsg, Hello, StatsMsg } from './types.js';

export interface Sink {
  // The encoded frames. One broadcast hands the same bytes to every sink, so
  // a sink must not change them. false: the viewer stopped reading; the hub
  // closes it.
  send(chunk: Uint8Array): boolean;
  close(): void;
}

const enc = new TextEncoder();
const RETRY_BYTES = enc.encode(RETRY);
const HEARTBEAT_BYTES = enc.encode(HEARTBEAT);

// The tailer's fan-out: the latest movements and stats for viewers who
// connect, and every block and stats message to every open stream. A frame
// is encoded once per broadcast, not once per viewer: with a few thousand
// streams the encoding would cost more than the tailer's query.
export class Hub {
  #blocks: BlockMsg[] = [];
  #stats: StatsMsg | null = null;
  readonly #sinks = new Set<Sink>();
  // the newest block no longer whole in the buffer: a viewer who saw it can resume
  #trimmedThrough = -1;
  // the encoded hello, until the next publish changes what it says
  #hello: Uint8Array | null = null;

  constructor(
    readonly maxStreams: number,
    private readonly bufferMoves = 40,
  ) {}

  get size(): number {
    return this.#sinks.size;
  }

  full(): boolean {
    return this.#sinks.size >= this.maxStreams;
  }

  newest(): number | null {
    return this.#blocks.at(-1)?.n ?? null;
  }

  // the latest bufferMoves movements, oldest block first
  hello(): Hello {
    const out: BlockMsg[] = [];
    let left = this.bufferMoves;
    for (let i = this.#blocks.length - 1; i >= 0 && left > 0; i--) {
      const b = this.#blocks[i]!;
      const moves = b.moves.slice(Math.max(0, b.moves.length - left));
      left -= moves.length;
      out.unshift({ ...b, moves });
    }
    return { blocks: out, stats: this.#stats };
  }

  #helloFrame(): Uint8Array {
    this.#hello ??= enc.encode(frame('hello', this.hello(), this.newest() ?? undefined));
    return this.#hello;
  }

  // The buffer at start, from the database; nothing is sent. Its first block
  // may be partial, so a viewer must have seen at least that one to resume.
  seed(blocks: BlockMsg[], releasedTo: number): void {
    this.#blocks = [...blocks];
    this.#trimmedThrough = blocks[0]?.n ?? releasedTo;
    this.#trim();
    this.#hello = null;
  }

  // seed, and a fresh hello to every open stream: viewers who connected
  // while the buffer was still empty (the server booting), and viewers whose
  // tape the tailer skipped past or the worker rewound, would otherwise wait
  // on blocks that never come or drop every lower-numbered one.
  reseed(blocks: BlockMsg[], releasedTo: number): void {
    this.seed(blocks, releasedTo);
    this.#broadcast(this.#helloFrame());
  }

  #trim(): void {
    let moves = this.#blocks.reduce((n, b) => n + b.moves.length, 0);
    while (this.#blocks.length > 1 && moves - this.#blocks[0]!.moves.length >= this.bufferMoves) {
      const b = this.#blocks.shift()!;
      moves -= b.moves.length;
      this.#trimmedThrough = Math.max(this.#trimmedThrough, b.n);
    }
  }

  // null: refused (MAX_STREAMS) or the stream failed at once; the route answers 503.
  subscribe(sink: Sink, lastEventId: number | null): (() => void) | null {
    if (this.full()) return null;
    this.#sinks.add(sink);
    let ok = this.#send(sink, RETRY_BYTES);
    const newest = this.newest();
    // A viewer ahead of the buffer saw blocks this buffer never had (the
    // server restarted, the worker's schema was recreated): resuming it would
    // send nothing, and its tape would wait for a block number it already has.
    if (ok && lastEventId !== null && newest !== null && lastEventId >= this.#trimmedThrough && lastEventId <= newest) {
      for (const b of this.#blocks) if (ok && b.n > lastEventId) ok = this.#send(sink, enc.encode(frame('block', b, b.n)));
      if (ok && this.#stats) ok = this.#send(sink, enc.encode(frame('stats', this.#stats)));
    } else if (ok) {
      ok = this.#send(sink, this.#helloFrame());
    }
    if (!ok) {
      this.#drop(sink);
      return null;
    }
    return () => {
      this.#sinks.delete(sink);
    };
  }

  // One tailer cycle: every block it released, as ONE chunk per viewer. A
  // stream's queue counts chunks, so a cycle of a hundred blocks (a stall, a
  // backfill round) sent block by block would fill every healthy viewer's
  // queue and drop them all.
  publishBlocks(blocks: readonly BlockMsg[]): void {
    if (!blocks.length) return;
    for (const b of blocks) this.#blocks.push(b);
    this.#trim();
    this.#hello = null;
    this.#broadcast(enc.encode(blocks.map((b) => frame('block', b, b.n)).join('')));
  }

  publishStats(s: StatsMsg): void {
    this.#stats = s;
    this.#hello = null;
    this.#broadcast(enc.encode(frame('stats', s)));
  }

  heartbeat(): void {
    this.#broadcast(HEARTBEAT_BYTES);
  }

  closeAll(): void {
    for (const s of this.#sinks) this.#drop(s);
  }

  #broadcast(chunk: Uint8Array): void {
    for (const s of this.#sinks) if (!this.#send(s, chunk)) this.#drop(s);
  }

  // A closed or cancelled stream throws on enqueue; one such viewer must not
  // abort the fan-out for the rest, so a throw counts as "stopped reading".
  #send(s: Sink, chunk: Uint8Array): boolean {
    try {
      return s.send(chunk);
    } catch {
      return false;
    }
  }

  // Closing an already-closed stream can throw too; the sink is gone either way.
  #drop(s: Sink): void {
    this.#sinks.delete(s);
    try {
      s.close();
    } catch {
      // already closed
    }
  }
}
