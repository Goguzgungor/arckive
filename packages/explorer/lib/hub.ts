import { HEARTBEAT, RETRY, frame } from './sse.js';
import type { BlockMsg, Hello, StatsMsg } from './types.js';

export interface Sink {
  // false: the viewer stopped reading; the hub closes it
  send(chunk: string): boolean;
  close(): void;
}

// The tailer's fan-out: the latest movements and stats for viewers who
// connect, and every block and stats message to every open stream.
export class Hub {
  #blocks: BlockMsg[] = [];
  #stats: StatsMsg | null = null;
  readonly #sinks = new Set<Sink>();
  // the newest block no longer whole in the buffer: a viewer who saw it can resume
  #trimmedThrough = -1;

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

  // The buffer at start, from the database; nothing is sent. Its first block
  // may be partial, so a viewer must have seen at least that one to resume.
  seed(blocks: BlockMsg[], releasedTo: number): void {
    this.#blocks = [...blocks];
    this.#trimmedThrough = blocks[0]?.n ?? releasedTo;
    this.#trim();
  }

  #trim(): void {
    let moves = this.#blocks.reduce((n, b) => n + b.moves.length, 0);
    while (this.#blocks.length > 1 && moves - this.#blocks[0]!.moves.length >= this.bufferMoves) {
      const b = this.#blocks.shift()!;
      moves -= b.moves.length;
      this.#trimmedThrough = Math.max(this.#trimmedThrough, b.n);
    }
  }

  subscribe(sink: Sink, lastEventId: number | null): (() => void) | null {
    if (this.full()) return null;
    this.#sinks.add(sink);
    let ok = sink.send(RETRY);
    if (lastEventId !== null && lastEventId >= this.#trimmedThrough) {
      for (const b of this.#blocks) if (ok && b.n > lastEventId) ok = sink.send(frame('block', b, b.n));
      if (ok && this.#stats) ok = sink.send(frame('stats', this.#stats));
    } else if (ok) {
      ok = sink.send(frame('hello', this.hello(), this.newest() ?? undefined));
    }
    if (!ok) this.#drop(sink);
    return () => {
      this.#sinks.delete(sink);
    };
  }

  publishBlock(b: BlockMsg): void {
    this.#blocks.push(b);
    this.#trim();
    this.#broadcast(frame('block', b, b.n));
  }

  publishStats(s: StatsMsg): void {
    this.#stats = s;
    this.#broadcast(frame('stats', s));
  }

  heartbeat(): void {
    this.#broadcast(HEARTBEAT);
  }

  closeAll(): void {
    for (const s of this.#sinks) this.#drop(s);
  }

  #broadcast(chunk: string): void {
    for (const s of this.#sinks) if (!s.send(chunk)) this.#drop(s);
  }

  #drop(s: Sink): void {
    this.#sinks.delete(s);
    s.close();
  }
}
