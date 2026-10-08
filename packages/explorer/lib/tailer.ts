import type pg from 'pg';
import { bytesToHex, type Tables } from './db.js';
import { unitsToDecimal } from './format.js';
import type { Hub } from './hub.js';
import { errText, type Logger } from './log.js';
import { nameOf } from './names.js';
import { releaseTo } from './release.js';
import type { BlockMsg, Move } from './types.js';
import { RollingWindow, type WindowBlock, type WindowMove } from './window.js';

export const CYCLE_MS = 250;
export const STATS_MS = 1000;
export const HEARTBEAT_MS = 15_000;
// A tailer further behind than this (a stall, a restart) skips to the last
// ~minute of blocks instead of replaying the gap at viewers.
const MAX_GAP = 600;
const CATCHUP = 150;
const MAX_ROWS = 50_000;

// a stream message carries the decimal value only, never the bigint
function toMove(m: WindowMove): Move {
  const out: Move = { tx: m.tx, li: m.li, from: m.from, to: m.to, value: m.value, lane: m.lane };
  if (m.fromName) out.fromName = m.fromName;
  if (m.toName) out.toName = m.toName;
  return out;
}

interface MoveRow {
  n: string;
  t: string;
  tx: Buffer;
  li: number;
  f: Buffer;
  r: Buffer;
  v: string;
  lane?: string | null;
}

export interface TailerDeps {
  pool: pg.Pool;
  t: Tables;
  hub: Hub;
  holdMs: number;
  lanes: () => boolean; // whether the _insights tables exist (refreshed by the runtime)
  log: Logger;
}

// One loop per process: every 250 ms it reads the worker's cursors, decides
// how far to release (release.ts), reads the released blocks' transfers with
// their lanes and addresses, publishes one `block` message per block (one
// chunk per cycle) and folds them into the rolling minute; stats go out once
// a second.
export class Tailer {
  lastReleased: number | null = null;
  window = new RollingWindow();
  private maxGap = MAX_GAP;
  private maxRows = MAX_ROWS;
  readonly #timings: number[] = [];

  constructor(private readonly d: TailerDeps) {}

  #movesSql(where: string, order: string): string {
    const { t } = this.d;
    const lanes = this.d.lanes();
    return `SELECT x.block_number::text AS n, extract(epoch from b.block_time)::bigint::text AS t, x.tx_hash AS tx, x.log_index AS li,
       fa.address AS f, ta.address AS r, x.value::text AS v${lanes ? ', i.lane' : ''}
     FROM ${t.usdc} x
     JOIN ${t.blocks} b ON b.block_number = x.block_number
     JOIN ${t.addresses} fa ON fa.id = x.from_id
     JOIN ${t.addresses} ta ON ta.id = x.to_id
     ${lanes ? `LEFT JOIN ${t.insights} i ON i.block_number = x.block_number AND i.log_index = x.log_index` : ''}
     WHERE ${where} ORDER BY ${order} LIMIT ${this.maxRows}`;
  }

  // The released range's movements in block and log order. A range that
  // reaches the row limit is cut short and the rest never reaches the tape:
  // say so, it means the skip-ahead is too wide for the chain's traffic.
  async #moves(from: number, to: number): Promise<MoveRow[]> {
    const r = await this.d.pool.query<MoveRow>(
      this.#movesSql('x.block_number > $1 AND x.block_number <= $2', 'x.block_number, x.log_index'),
      [from, to],
    );
    if (r.rows.length >= this.maxRows) this.d.log.warn({ from, to, rows: r.rows.length }, 'tailer read hit its row limit; later movements in the range are not on the tape');
    return r.rows;
  }

  #group(rows: MoveRow[]): { msgs: BlockMsg[]; win: WindowBlock[] } {
    const win: WindowBlock[] = [];
    for (const r of rows) {
      const n = Number(r.n);
      if (win.at(-1)?.n !== n) win.push({ n, t: Number(r.t), moves: [] });
      const from = bytesToHex(r.f);
      const to = bytesToHex(r.r);
      const m: WindowMove = { tx: bytesToHex(r.tx), li: r.li, from, to, value: unitsToDecimal(r.v), raw: BigInt(r.v), lane: r.lane ?? null };
      const fromName = nameOf(from);
      const toName = nameOf(to);
      if (fromName) m.fromName = fromName;
      if (toName) m.toName = toName;
      win.at(-1)!.moves.push(m);
    }
    const msgs = win.map((b) => ({ n: b.n, t: b.t, moves: b.moves.map(toMove) }));
    return { msgs, win };
  }

  async #target(): Promise<number | null> {
    const { t, pool, holdMs } = this.d;
    const lanes = this.d.lanes();
    const r = await pool.query<{ cursor: string | null; icursor: string | null; held: string | null }>(
      `SELECT (SELECT last_block FROM ${t.cursor} WHERE id = 1)::text AS cursor,
              ${lanes ? `(SELECT last_block FROM ${t.insightsCursor} WHERE id = 1)::text` : 'NULL::text'} AS icursor,
              (SELECT max(block_number) FROM ${t.blocks}
                WHERE block_number > $1 AND _ingested_at <= now() - make_interval(secs => $2::float8 / 1000))::text AS held`,
      [this.lastReleased ?? -1, holdMs],
    );
    const row = r.rows[0]!;
    const num = (v: string | null): number | null => (v === null ? null : Number(v));
    return releaseTo({ cursor: num(row.cursor), insightsCursor: lanes ? num(row.icursor) : undefined, heldThrough: num(row.held) });
  }

  // The buffer and the rolling minute from the database: the last ~minute of
  // released blocks, so a restart neither greets viewers with an empty tape
  // nor under-counts the headline. Viewers who connected while the server was
  // booting got an empty hello; the reseed greets them again.
  async init(): Promise<void> {
    const to = await this.#target();
    if (to === null || to < 0) return;
    await this.#reseed(to);
  }

  // The last CATCHUP blocks up to `to` as the hub's buffer and a fresh hello
  // to every open stream; they are folded into the rolling minute.
  async #reseed(to: number): Promise<void> {
    const { msgs, win } = this.#group(await this.#moves(to - CATCHUP, to));
    for (const b of win) this.window.add(b);
    this.d.hub.reseed(msgs, to);
    this.lastReleased = to;
  }

  async cycle(): Promise<void> {
    const started = performance.now();
    try {
      if (this.lastReleased === null) return await this.init();
      const to = await this.#target();
      if (to === null) return;
      if (to < this.lastReleased - this.maxGap) {
        // The worker's cursor went back: its schema was recreated and it is
        // indexing again from an earlier block. Start over as at boot, with a
        // new rolling minute; the old one counts blocks that no longer exist.
        this.d.log.warn({ released: this.lastReleased, cursor: to }, 'the worker cursor went back; reloading the tape');
        this.window = new RollingWindow();
        this.lastReleased = null;
        return await this.init();
      }
      if (to <= this.lastReleased) return;
      // Far behind (a stall, a restart): the last CATCHUP blocks as a fresh
      // hello rather than the gap replayed at viewers.
      if (to - this.lastReleased > this.maxGap) return await this.#reseed(to);
      const { msgs, win } = this.#group(await this.#moves(this.lastReleased, to));
      for (const b of win) this.window.add(b);
      this.d.hub.publishBlocks(msgs);
      this.lastReleased = to;
    } finally {
      this.#timings.push(performance.now() - started);
      if (this.#timings.length > 200) this.#timings.shift();
    }
  }

  cycleStats(): { last: number | null; p95: number | null } {
    if (!this.#timings.length) return { last: null, p95: null };
    const s = [...this.#timings].sort((a, b) => a - b);
    const round = (v: number): number => Math.round(v * 10) / 10;
    return { last: round(this.#timings.at(-1)!), p95: round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!) };
  }

  start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      let wait = CYCLE_MS;
      try {
        await this.cycle();
      } catch (err) {
        // the database is down or slow: try again in a second; streams stay open
        wait = 1000;
        this.d.log.warn({ err: errText(err) }, 'tailer cycle failed');
      }
      if (!stopped) timer = setTimeout(loop, wait);
    };
    void loop();
    const stats = setInterval(() => this.d.hub.publishStats(this.window.stats(Date.now())), STATS_MS);
    const beat = setInterval(() => this.d.hub.heartbeat(), HEARTBEAT_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(stats);
      clearInterval(beat);
    };
  }
}
