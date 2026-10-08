import type pg from 'pg';
import type { Tables } from './db.js';
import { errText, type Logger } from './log.js';

// One writer across replicas: a fold takes this transaction-scoped lock
// first, and a replica that cannot get it skips the round.
export const ROLLUP_LOCK = 0x61726b76; // "arkv"
// The largest range one transaction folds; the backfill goes through in these.
export const MAX_SPAN = 50_000n;
const MIN_SPAN = 500n;
const QUERY_CANCELED = '57014';
const IDLE_MS = 2000;

export type StepResult = 'more' | 'idle' | 'locked';

export interface RollupOptions {
  maxSpan?: bigint;
  // tests: runs after the fold and the cursor update, before COMMIT
  beforeCommit?: () => Promise<void>;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

// Received and sent per address per UTC day for (from, to]; a self-transfer
// counts on both sides. The upsert adds onto what earlier ranges folded.
function foldSql(t: Tables): string {
  const day = `(b.block_time AT TIME ZONE 'UTC')::date`;
  const from = `FROM ${t.usdc} t JOIN ${t.blocks} b ON b.block_number = t.block_number WHERE t.block_number > $1 AND t.block_number <= $2`;
  return `
INSERT INTO explorer.address_daily AS d (address_id, day, in_value, out_value, in_count, out_count)
SELECT address_id, day, sum(in_value), sum(out_value), sum(in_count)::int, sum(out_count)::int
FROM (
  SELECT t.to_id AS address_id, ${day} AS day, t.value AS in_value, 0::numeric AS out_value, 1 AS in_count, 0 AS out_count ${from}
  UNION ALL
  SELECT t.from_id, ${day}, 0, t.value, 0, 1 ${from}
) m
GROUP BY address_id, day
ON CONFLICT (address_id, day) DO UPDATE SET
  in_value = d.in_value + excluded.in_value,
  out_value = d.out_value + excluded.out_value,
  in_count = d.in_count + excluded.in_count,
  out_count = d.out_count + excluded.out_count`;
}

// Folds usdc_transfer into explorer.address_daily up to the worker's _cursor.
// Rows and rollup_cursor commit in one transaction, so a crash folds nothing
// twice. A range that outlives the statement timeout (the 2026-09-15 burst
// carries 90–180 transfers a block) halves the span; a success doubles it
// back toward the maximum.
export class Rollup {
  #span: bigint;
  readonly #maxSpan: bigint;
  readonly #sql: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly t: Tables,
    private readonly opts: RollupOptions = {},
  ) {
    this.#maxSpan = opts.maxSpan ?? MAX_SPAN;
    this.#span = this.#maxSpan;
    this.#sql = foldSql(t);
  }

  get span(): bigint {
    return this.#span;
  }

  async rolledTo(): Promise<number | null> {
    const r = await this.pool.query<{ n: string }>('SELECT block_number::text AS n FROM explorer.rollup_cursor WHERE id = 1');
    return r.rowCount ? Number(r.rows[0]!.n) : null;
  }

  async step(): Promise<StepResult> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [ROLLUP_LOCK]);
      if (!lock.rows[0]!.ok) {
        await c.query('ROLLBACK');
        return 'locked';
      }
      // a backfill range may need longer than the role's 5 s page budget
      await c.query("SET LOCAL statement_timeout = '120s'");
      const head = await c.query<{ n: string }>(`SELECT last_block::text AS n FROM ${this.t.cursor} WHERE id = 1`);
      if (!head.rowCount) {
        await c.query('ROLLBACK');
        return 'idle';
      }
      const cursor = BigInt(head.rows[0]!.n);
      const done = await c.query<{ n: string }>('SELECT block_number::text AS n FROM explorer.rollup_cursor WHERE id = 1');
      const from = done.rowCount ? BigInt(done.rows[0]!.n) : -1n;
      if (from >= cursor) {
        await c.query('ROLLBACK');
        return 'idle';
      }
      // Empty stretches (the chain's first weeks) cost one lookup, not a range each.
      const next = await c.query<{ n: string | null }>(
        `SELECT min(block_number)::text AS n FROM ${this.t.blocks} WHERE block_number > $1 AND block_number <= $2`,
        [from.toString(), cursor.toString()],
      );
      const first = next.rows[0]!.n === null ? null : BigInt(next.rows[0]!.n);
      const to = first === null ? cursor : min(cursor, first - 1n + this.#span);
      if (first !== null) await c.query(this.#sql, [from.toString(), to.toString()]);
      await c.query(
        `INSERT INTO explorer.rollup_cursor (id, block_number) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET block_number = excluded.block_number`,
        [to.toString()],
      );
      await this.opts.beforeCommit?.();
      await c.query('COMMIT');
      this.#span = min(this.#maxSpan, this.#span * 2n);
      return to < cursor ? 'more' : 'idle';
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === QUERY_CANCELED) {
        const floor = this.#maxSpan < MIN_SPAN ? 1n : MIN_SPAN;
        this.#span = max(floor, this.#span / 2n);
      }
      throw err;
    } finally {
      c.release();
    }
  }

  // Through the backfill range after range, then every 2 s on what is new.
  start(logger: Logger): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      let wait = IDLE_MS;
      try {
        if ((await this.step()) === 'more') wait = 0;
      } catch (err) {
        logger.warn({ err: errText(err), span: this.#span.toString() }, 'rollup range failed');
      }
      if (!stopped) timer = setTimeout(run, wait);
    };
    timer = setTimeout(run, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
}
