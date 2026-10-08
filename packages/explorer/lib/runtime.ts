import type pg from 'pg';
import { loadConfig, type Config } from './config.js';
import { createPool, tables, type Tables } from './db.js';
import { ensureExplorerSchema } from './explorer-schema.js';
import { Hub } from './hub.js';
import { errText, log } from './log.js';
import { Rollup } from './rollup.js';
import { SchemaError, checkSchema, hasAddressIndexes, hasInsights } from './schema.js';
import { Tailer } from './tailer.js';
import { Tokens, rpcTokenReader, type TokenReader } from './tokens.js';
import { loadInsightsInfo, type InsightsInfo } from './tx.js';

export class ArchiveUnavailable extends Error {}

export interface Head {
  block: number;
  time: number;
}

export interface Runtime {
  cfg: Config;
  pool: pg.Pool; // pages, routes and token writes
  jobs: pg.Pool; // the tailer, the rollup, the refresh
  t: Tables;
  hub: Hub;
  tokens: Tokens;
  tailer: Tailer;
  rollup: Rollup;
  ready: boolean;
  insights: InsightsInfo;
  head: Head | null;
  dbBytes: number | null;
  rolledTo: number | null;
  stop(): Promise<void>; // stops the jobs, closes the streams, ends both pools
}

const REFRESH_MS = 5000;
// what stop() undoes: the boot loop, the tailer, the rollup, the refresh timer
const STOPS = new WeakMap<Runtime, Array<() => void>>();

// Two pools: a burst of page views must not take the tailer's or the
// rollup's connections (the rollup holds one for up to 120 s), and a page
// waiting for a connection gives up after 3 s instead of hanging.
export function createRuntime(cfg: Config, reader: TokenReader = rpcTokenReader(cfg.arcRpc)): Runtime {
  const pool = createPool(cfg, { max: 10, connectionTimeoutMillis: 3000 });
  // a database that stops answering connects must not freeze the tailer for minutes
  const jobs = createPool(cfg, { max: 4, connectionTimeoutMillis: 10_000 });
  // an idle client's error (the database restarting) must not crash the process
  for (const p of [pool, jobs]) p.on('error', (err) => log.warn({ err: errText(err) }, 'idle database client failed'));
  const t = tables(cfg);
  const hub = new Hub(cfg.maxStreams);
  const stops: Array<() => void> = [];
  const rt: Runtime = {
    cfg, pool, jobs, t, hub,
    tokens: new Tokens(pool, reader),
    tailer: undefined as unknown as Tailer,
    rollup: new Rollup(jobs, t),
    ready: false,
    insights: { on: false, firstBlock: null, firstTime: null },
    head: null,
    dbBytes: null,
    rolledTo: null,
    async stop() {
      for (const s of stops.splice(0)) s();
      hub.closeAll();
      await Promise.all([pool.end(), jobs.end()]);
    },
  };
  rt.tailer = new Tailer({ pool: jobs, t, hub, holdMs: cfg.laneHoldMs, lanes: () => rt.insights.on, log });
  STOPS.set(rt, stops);
  return rt;
}

async function refresh(rt: Runtime): Promise<void> {
  const on = await hasInsights(rt.jobs, rt.t);
  // the first lane's block is read once it exists: older transactions predate lanes
  if (on !== rt.insights.on || (on && rt.insights.firstBlock === null)) rt.insights = await loadInsightsInfo(rt.jobs, rt.t, on);
  const h = await rt.jobs.query<{ n: string; t: string | null }>(
    `SELECT c.last_block::text AS n,
            (SELECT extract(epoch from b.block_time)::bigint::text FROM ${rt.t.blocks} b
              WHERE b.block_number <= c.last_block ORDER BY b.block_number DESC LIMIT 1) AS t
     FROM ${rt.t.cursor} c WHERE c.id = 1`,
  );
  rt.head = h.rowCount && h.rows[0]!.t !== null ? { block: Number(h.rows[0]!.n), time: Number(h.rows[0]!.t) } : null;
  const size = await rt.jobs.query<{ b: string }>('SELECT pg_database_size(current_database())::text AS b');
  rt.dbBytes = Number(size.rows[0]!.b);
  rt.rolledTo = await rt.rollup.rolledTo();
}

// Retries a database that does not answer every second; stops the process
// (exit 1) when the schema is not the one the explorer reads — a clear error
// at start instead of a 500 on every page.
export async function bootRuntime(rt: Runtime, exit: (code: number) => void = (c) => process.exit(c)): Promise<void> {
  const stops = STOPS.get(rt)!;
  let stopped = false;
  stops.push(() => {
    stopped = true;
  });
  for (;;) {
    if (stopped) return;
    try {
      await checkSchema(rt.jobs, rt.t);
      if (!(await hasAddressIndexes(rt.jobs, rt.t))) {
        log.warn(
          { schema: rt.t.schema },
          'the worker did not build ordered address indexes (_meta address_indexes is not true): address pages will read every row of an address; set storage.addressIndexes on the Indexer',
        );
      }
      await ensureExplorerSchema(rt.jobs);
      await refresh(rt);
      break;
    } catch (err) {
      if (err instanceof SchemaError) {
        log.fatal({ err: errText(err) }, 'the explorer cannot read this database');
        exit(1);
        return;
      }
      log.warn({ err: errText(err) }, 'database not answering; retrying');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (stopped) return;
  stops.push(rt.tailer.start(), rt.rollup.start(log));
  // Each refresh starts 5 s after the last one ended: on a slow database an
  // interval would stack refreshes on the jobs pool behind each other.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const again = (): void => {
    timer = setTimeout(() => {
      refresh(rt)
        .catch((err) => log.warn({ err: errText(err) }, 'refresh failed'))
        .finally(() => {
          if (!stopped) again();
        });
    }, REFRESH_MS);
  };
  again();
  stops.push(() => clearTimeout(timer));
  rt.ready = true;
  log.info({ schema: rt.t.schema, lanes: rt.insights.on }, 'explorer ready');
}

const KEY = Symbol.for('arckive.explorer.runtime');
type Global = typeof globalThis & { [KEY]?: Runtime };

// One runtime per process, kept on globalThis: Next bundles
// instrumentation.ts and each route separately, so a module-level singleton
// would exist once per bundle — two tailers, and streams that never see the tape.
export function getRuntime(): Runtime {
  // `next build` renders static pages without a database
  if (process.env['NEXT_PHASE'] === 'phase-production-build') throw new ArchiveUnavailable('no runtime during the build');
  const g = globalThis as Global;
  if (!g[KEY]) {
    const rt = createRuntime(loadConfig());
    g[KEY] = rt;
    void bootRuntime(rt);
  }
  return g[KEY];
}

export function readyRuntime(): Runtime {
  const rt = getRuntime();
  if (!rt.ready) throw new ArchiveUnavailable('the archive is not answering');
  return rt;
}
