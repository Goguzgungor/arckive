import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildControlTables, extractEventDefs, type DecodedRow } from '@arckive/core';
import {
  Compactor, LayoutError, Partitions, bootstrap, commitBatch, contractMeta, createStore, getCursor, initCursor, type Store,
} from '../src/db.js';

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ABI = [
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
];
const SCHEMA = 'idx_demo';
const defs = extractEventDefs('usdc', ADDR, ABI);
const META = { ...contractMeta(defs), partition_blocks: '1000' };
const hex = (h: string) => Buffer.from(h.slice(2), 'hex');

function row(blockNumber: number, logIndex: number): DecodedRow {
  return {
    tableName: 'usdc_transfer',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date('2026-07-03T00:00:00Z'),
    columns: {
      block_number: String(blockNumber),
      tx_hash: hex('0x' + 'b'.repeat(64)),
      log_index: logIndex,
      from_id: hex('0x' + '1'.repeat(40)),
      to_id: hex('0x' + '2'.repeat(40)),
      value: '100',
    },
  };
}

// counts every statement sent through clients of this pool
function countingPool(uri: string): { pool: pg.Pool; sent: { n: number } } {
  const sent = { n: 0 };
  const pool = new pg.Pool({ connectionString: uri });
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
      sent.n++;
      return query(...a);
    };
  });
  return { pool, sent };
}

describe('db (storage layout 2)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let store: Store;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    store = createStore(SCHEMA, defs, 1000);
    await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], META);
    await initCursor(pool, SCHEMA, 9n);
  });

  it('bootstrap is idempotent and records the layout and each contract', async () => {
    await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], META);
    const meta = await pool.query(`SELECT key, value FROM ${SCHEMA}._meta ORDER BY key`);
    expect(meta.rows).toEqual([
      { key: 'contract:usdc_transfer', value: ADDR.toLowerCase() },
      { key: 'layout', value: '2' },
      { key: 'partition_blocks', value: '1000' },
    ]);
    expect(await getCursor(pool, SCHEMA)).toBe(9n);
  });

  it('refuses a schema written by layout 1', async () => {
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}._cursor (id smallint PRIMARY KEY, last_block bigint NOT NULL)`);
    await pool.query(`CREATE TABLE ${SCHEMA}._meta (key text PRIMARY KEY, value text NOT NULL)`);
    await expect(
      bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], contractMeta(defs)),
    ).rejects.toBeInstanceOf(LayoutError);
  });

  it('refuses a schema with a cursor but no _meta table', async () => {
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}._cursor (id smallint PRIMARY KEY, last_block bigint NOT NULL)`);
    await expect(
      bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], META),
    ).rejects.toBeInstanceOf(LayoutError);
  });

  it('refuses a different address for an existing table and leaves _meta unchanged', async () => {
    const other = contractMeta(extractEventDefs('usdc', '0x' + '99'.repeat(20), ABI));
    await expect(
      bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], { ...other, partition_blocks: '1000' }),
    ).rejects.toBeInstanceOf(LayoutError);
    const meta = await pool.query(`SELECT value FROM ${SCHEMA}._meta WHERE key = 'contract:usdc_transfer'`);
    expect(meta.rows).toEqual([{ value: ADDR.toLowerCase() }]);
  });

  it('refuses a different partition size', async () => {
    await expect(
      bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], { ...contractMeta(defs), partition_blocks: '2000' }),
    ).rejects.toBeInstanceOf(LayoutError);
  });

  it('commitBatch is idempotent, writes _blocks and advances the cursor', async () => {
    expect(await commitBatch(pool, store, [row(10, 0), row(10, 1)], [], 10n)).toBe(2);
    expect(await commitBatch(pool, store, [row(10, 0), row(10, 1)], [], 10n)).toBe(0);
    expect(await getCursor(pool, SCHEMA)).toBe(10n);
    const r = await pool.query(`SELECT tx_hash FROM ${SCHEMA}.usdc_transfer ORDER BY log_index`);
    expect(r.rows[0].tx_hash).toEqual(hex('0x' + 'b'.repeat(64)));
    const blocks = await pool.query(`SELECT block_number, block_hash FROM ${SCHEMA}._blocks`);
    expect(blocks.rows).toEqual([{ block_number: '10', block_hash: hex('0x' + 'a'.repeat(64)) }]);
  });

  it('plans partitions sorted by table then partition number', () => {
    const planned = new Partitions(SCHEMA, 10n).plan(['b_t', 'a_t'], [35n, 5n, 15n]);
    expect(planned.map((p) => [p.table, p.n])).toEqual([
      ['a_t', 0n], ['a_t', 1n], ['a_t', 3n], ['b_t', 0n], ['b_t', 1n], ['b_t', 3n],
    ]);
  });

  it('sends the same number of statements for 2 rows and for 200', async () => {
    const { pool: counted, sent } = countingPool(container.getConnectionUri());
    try {
      await commitBatch(counted, store, [row(20, 0), row(20, 1)], [], 20n); // creates the partitions
      sent.n = 0;
      await commitBatch(counted, store, [row(21, 0), row(21, 1)], [], 21n);
      const small = sent.n;
      sent.n = 0;
      await commitBatch(counted, store, Array.from({ length: 200 }, (_, i) => row(22, i)), [], 22n);
      expect(sent.n).toBe(small);
      expect(small).toBe(7); // BEGIN, address INSERT, address SELECT, _blocks, usdc_transfer, cursor, COMMIT
    } finally {
      await counted.end();
    }
  });

  it('an empty batch advances the cursor and inserts nothing', async () => {
    expect(await commitBatch(pool, store, [], [], 30n)).toBe(0);
    expect(await getCursor(pool, SCHEMA)).toBe(30n);
  });

  it('a batch across a partition boundary creates the next partition', async () => {
    await commitBatch(pool, store, [row(999, 0), row(1000, 0)], [], 1000n);
    const parts = await pool.query(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = $1 AND p.relname = 'usdc_transfer' ORDER BY 1`,
      [SCHEMA],
    );
    expect(parts.rows.map((x) => x.relname)).toEqual(['usdc_transfer_p0', 'usdc_transfer_p1']);
  });

  it('a rolled-back batch is not remembered as having made its partition', async () => {
    const bad = row(5000, 0);
    bad.columns['value'] = 'not a number';
    await expect(commitBatch(pool, store, [bad], [], 5000n)).rejects.toThrow();
    expect(await commitBatch(pool, store, [row(5000, 0)], [], 5000n)).toBe(1);
  });

  it('stores each address once and points rows at it', async () => {
    await commitBatch(pool, store, [row(10, 0), row(10, 1)], [], 10n);
    const a = await pool.query(`SELECT id, address FROM ${SCHEMA}._addresses ORDER BY id`);
    expect(a.rows.map((r) => r.address)).toEqual([hex('0x' + '1'.repeat(40)), hex('0x' + '2'.repeat(40))]);
    const t = await pool.query(`SELECT from_id, to_id FROM ${SCHEMA}.usdc_transfer ORDER BY log_index`);
    expect(t.rows).toEqual([{ from_id: a.rows[0].id, to_id: a.rows[1].id }, { from_id: a.rows[0].id, to_id: a.rows[1].id }]);
  });

  it('burns no identity values when the same addresses are committed again', async () => {
    for (let i = 0; i < 5; i++) await commitBatch(pool, store, [row(10 + i, 0)], [], BigInt(10 + i));
    // a burned value shows only in the next id actually handed out
    const fresh = row(20, 0);
    fresh.columns['to_id'] = hex('0x' + '3'.repeat(40));
    await commitBatch(pool, store, [fresh], [], 20n);
    const r = await pool.query(`SELECT max(id)::int AS m FROM ${SCHEMA}._addresses`);
    expect(r.rows[0].m).toBe(3);
  });

  it('a table without address columns sends no address statements', async () => {
    const plain = extractEventDefs('plain', ADDR, [{
      type: 'event', name: 'Done', inputs: [
        { name: 'amount', type: 'uint256', indexed: false },
        { name: 'ref', type: 'bytes32', indexed: false },
      ],
    }]);
    const schema = 'idx_plain';
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const st = createStore(schema, plain, 1000);
    await bootstrap(pool, schema, buildControlTables(schema), [...st.tables.values()], contractMeta(plain));
    await initCursor(pool, schema, 9n);
    const { pool: counted, sent } = countingPool(container.getConnectionUri());
    try {
      const r = (b: number): DecodedRow => ({
        tableName: 'plain_done', blockHash: `0x${'a'.repeat(64)}`, blockTime: new Date(0),
        columns: { block_number: String(b), tx_hash: hex('0x' + 'b'.repeat(64)), log_index: 0, amount: '1', ref: hex('0x' + 'c'.repeat(64)) },
      });
      await commitBatch(counted, st, [r(20)], [], 20n); // creates the partitions
      sent.n = 0;
      await commitBatch(counted, st, [r(21)], [], 21n);
      expect(sent.n).toBe(5); // BEGIN, _blocks, plain_done, cursor, COMMIT
    } finally {
      await counted.end();
    }
  });

  it('keeps an address id across commits', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    await commitBatch(pool, store, [row(11, 0)], [], 11n);
    const n = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}._addresses`);
    expect(n.rows[0].n).toBe(2);
  });

  it('a rolled-back commit leaves no address behind and the next commit re-inserts it', async () => {
    const bad = row(5000, 0);
    bad.columns['value'] = 'not a number';
    bad.columns['to_id'] = hex('0x' + '3'.repeat(40));
    await expect(commitBatch(pool, store, [bad], [], 5000n)).rejects.toThrow();
    const left = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}._addresses`);
    expect(left.rows[0].n).toBe(0);
    const ok = row(5000, 0);
    ok.columns['to_id'] = hex('0x' + '3'.repeat(40));
    expect(await commitBatch(pool, store, [ok], [], 5000n)).toBe(1);
    const r = await pool.query(`SELECT "to" FROM ${SCHEMA}.usdc_transfer_hex WHERE block_number = 5000`);
    expect(r.rows[0].to).toBe('0x' + '3'.repeat(40));
  });

  it('does not mutate the caller rows, so a retried batch still carries Buffers', async () => {
    const r = row(13, 0);
    await commitBatch(pool, store, [r], [], 13n);
    expect(Buffer.isBuffer(r.columns['from_id'])).toBe(true);
  });

  it('keeps a NULL address column NULL', async () => {
    const r = row(12, 0);
    r.columns['to_id'] = null;
    await commitBatch(pool, store, [r], [], 12n);
    const t = await pool.query(`SELECT to_id FROM ${SCHEMA}.usdc_transfer WHERE block_number = 12`);
    expect(t.rows[0].to_id).toBeNull();
  });

  it('writes block time once per block and the readable view joins it', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    const b = await pool.query(`SELECT block_time, _ingested_at FROM ${SCHEMA}._blocks`);
    expect(b.rows[0].block_time).toEqual(new Date('2026-07-03T00:00:00Z'));
    expect(b.rows[0]._ingested_at).toBeInstanceOf(Date);
    const v = await pool.query(`SELECT block_time, "from", tx_hash FROM ${SCHEMA}.usdc_transfer_hex`);
    expect(v.rows[0]).toEqual({ block_time: new Date('2026-07-03T00:00:00Z'), from: '0x' + '1'.repeat(40), tx_hash: '0x' + 'b'.repeat(64) });
  });

  it('dead letters are written in the same transaction', async () => {
    await commitBatch(pool, store, [], [{
      blockNumber: 11n, txHash: '0x' + 'c'.repeat(64), logIndex: 0,
      address: ADDR.toLowerCase(), topics: ['0xdead'], data: '0x01', error: 'decode error',
    }], 11n);
    const r = await pool.query(`SELECT error, topics FROM ${SCHEMA}._dead_letter`);
    expect(r.rows[0]).toEqual({ error: 'decode error', topics: ['0xdead'] });
    expect(await getCursor(pool, SCHEMA)).toBe(11n);
  });

  it('rebuilds a finished partition once, when ingest moves past it', async () => {
    const enqueued: string[] = [];
    const s = createStore(SCHEMA, defs, 1000, { enqueue: (_schema: string, p: string) => enqueued.push(p) } as never);
    await commitBatch(pool, s, [row(10, 0)], [], 10n);
    await commitBatch(pool, s, [row(20, 0)], [], 20n);
    expect(enqueued).toEqual([]);
    await commitBatch(pool, s, [row(1000, 0)], [], 1000n);
    expect(enqueued.sort()).toEqual(['_blocks_p0', 'usdc_transfer_p0']);
    await commitBatch(pool, s, [row(1001, 0)], [], 1001n);
    expect(enqueued).toHaveLength(2);
  });

  it('a restart in the middle of a partition does not revisit the one before it', async () => {
    const enqueued: string[] = [];
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    await commitBatch(pool, store, [row(1000, 0)], [], 1000n); // first process moved into p1
    const restarted = createStore(SCHEMA, defs, 1000, { enqueue: (_s: string, p: string) => enqueued.push(p) } as never);
    await commitBatch(pool, restarted, [row(1500, 0)], [], 1500n);
    expect(enqueued).toEqual([]);
    await commitBatch(pool, restarted, [row(2000, 0)], [], 2000n);
    expect(enqueued.sort()).toEqual(['_blocks_p1', 'usdc_transfer_p1']);
  });

  it('Compactor rebuilds the partition indexes concurrently and survives a missing partition', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    const warned: unknown[] = [];
    const debugged: unknown[] = [];
    const c = new Compactor(pool, { info: () => {}, warn: (o: unknown) => warned.push(o), debug: (o: unknown) => debugged.push(o) });
    c.enqueue(SCHEMA, 'usdc_transfer_p0');
    c.enqueue(SCHEMA, 'usdc_transfer_p999');
    await c.idle();
    expect(warned).toHaveLength(0); // a missing partition is debug, not warn
    expect(debugged).toHaveLength(1);
    const bad = await pool.query(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = 'usdc_transfer_p0' AND NOT i.indisvalid`,
      [SCHEMA],
    );
    expect(bad.rows).toEqual([]);
    const total = await pool.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND tablename = 'usdc_transfer_p0'`, [SCHEMA],
    );
    expect(total.rows[0].n).toBeGreaterThan(0);
  });

  it('Compactor drops invalid leftovers of a failed rebuild', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    // simulate what a failed REINDEX CONCURRENTLY leaves behind
    await pool.query(`CREATE INDEX usdc_transfer_p0_ccnew ON ${SCHEMA}.usdc_transfer_p0 (log_index)`);
    await pool.query(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${SCHEMA}.usdc_transfer_p0_ccnew'::regclass`,
    );
    const c = new Compactor(pool, { info: () => {}, warn: () => {} });
    // a real REINDEX failure is hard to provoke; exercise the cleanup it runs
    await (c as unknown as { dropInvalid(cl: undefined, s: string, p: string): Promise<boolean> })
      .dropInvalid(undefined, SCHEMA, 'usdc_transfer_p0');
    const left = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'usdc_transfer_p0_ccnew'`, [SCHEMA]);
    expect(left.rows).toEqual([]);
  });

  it('Compactor.close drops queued work and later enqueues', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    const infos: unknown[] = [];
    const c = new Compactor(pool, { info: (o: unknown) => infos.push(o), warn: () => {} });
    c.enqueue(SCHEMA, 'usdc_transfer_p0');
    c.close();
    c.enqueue(SCHEMA, 'usdc_transfer_p0');
    await c.idle();
    expect(infos).toEqual([]);
  });

  it('only rebuilds partitions that exist for a sparse table', async () => {
    const enqueued: string[] = [];
    const s = createStore(SCHEMA, defs, 1000, { enqueue: (_s: string, p: string) => enqueued.push(p) } as never);
    await commitBatch(pool, s, [row(10, 0)], [], 10n);
    await commitBatch(pool, s, [row(5010, 0)], [], 5010n);
    expect(enqueued.filter((p) => p.startsWith('usdc_transfer')).sort()).toEqual(['usdc_transfer_p0']);
  });

  it('a dense table enqueues each finished partition once, even across a jump', async () => {
    const enqueued: string[] = [];
    const s = createStore(SCHEMA, defs, 1000, { enqueue: (_s: string, p: string) => enqueued.push(p) } as never);
    await commitBatch(pool, s, [row(10, 0)], [], 10n);
    // one batch with rows in p1..p3 finishes p0, p1 and p2 at once
    await commitBatch(pool, s, [row(1010, 0), row(2010, 0), row(3010, 0)], [], 3010n);
    await commitBatch(pool, s, [row(4010, 0)], [], 4010n);
    await commitBatch(pool, s, [row(4011, 0)], [], 4011n);
    expect(enqueued.filter((p) => p.startsWith('usdc_transfer')).sort())
      .toEqual(['usdc_transfer_p0', 'usdc_transfer_p1', 'usdc_transfer_p2', 'usdc_transfer_p3']);
  });

  it('one address in two tables of the same batch gets one _addresses row and one id', async () => {
    const approvalAbi = [{
      type: 'event', name: 'Approval',
      inputs: [
        { name: 'owner', type: 'address', indexed: true },
        { name: 'value', type: 'uint256', indexed: false },
      ],
    }];
    const two = [...defs, ...extractEventDefs('token', ADDR, approvalAbi)];
    const s2 = createStore(SCHEMA, two, 1000);
    await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...s2.tables.values()], { ...contractMeta(two), partition_blocks: '1000' });
    const shared = hex('0x' + '1'.repeat(40));
    const approval: DecodedRow = {
      tableName: 'token_approval',
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date('2026-07-03T00:00:00Z'),
      columns: {
        block_number: '10', tx_hash: hex('0x' + 'b'.repeat(64)), log_index: 1,
        owner_id: shared, value: '5',
      },
    };
    await commitBatch(pool, s2, [row(10, 0), approval], [], 10n); // row(): from_id = shared too
    const addrs = await pool.query(`SELECT id FROM ${SCHEMA}._addresses WHERE address = $1`, [shared]);
    expect(addrs.rows).toHaveLength(1);
    const t = await pool.query(`SELECT from_id FROM ${SCHEMA}.usdc_transfer`);
    const a = await pool.query(`SELECT owner_id FROM ${SCHEMA}.token_approval`);
    expect(t.rows[0].from_id).toBe(addrs.rows[0].id);
    expect(a.rows[0].owner_id).toBe(addrs.rows[0].id);
  });

  describe('address indexes', () => {
    const S = 'idx_addr';
    const indexDefs = async (table: string): Promise<string[]> =>
      (await pool.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2', [S, table]))
        .rows.map((r: { indexdef: string }) => r.indexdef);
    const fresh = async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
      const st = createStore(S, defs, 1000, undefined, true);
      await bootstrap(pool, S, buildControlTables(S), [...st.tables.values()], { ...META, address_indexes: 'true' });
      await initCursor(pool, S, 9n);
      return st;
    };

    it('are on the parent and on every partition, including ones created later', async () => {
      const st = await fresh();
      await commitBatch(pool, st, [row(10, 0)], [], 10n); // partition 0
      await commitBatch(pool, st, [row(2500, 0)], [], 2500n); // partition 2, created after bootstrap
      for (const table of ['usdc_transfer', 'usdc_transfer_p0', 'usdc_transfer_p2']) {
        const idx = await indexDefs(table);
        expect(idx.some((d) => d.includes('(from_id, block_number, log_index)'))).toBe(true);
        expect(idx.some((d) => d.includes('(to_id, block_number, log_index)'))).toBe(true);
        expect(idx.some((d) => d.endsWith('(from_id)'))).toBe(false);
      }
    });

    it('give "latest 25 for this address" in index order, without a sort', async () => {
      const st = await fresh();
      await commitBatch(pool, st, Array.from({ length: 300 }, (_, i) => row(10 + i, 0)), [], 400n);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL enable_seqscan = off');
        await c.query('SET LOCAL enable_sort = off');
        const plan = JSON.stringify((await c.query(
          `EXPLAIN (FORMAT JSON) SELECT block_number, log_index FROM ${S}.usdc_transfer
           WHERE from_id = (SELECT id FROM ${S}._addresses WHERE address = $1)
           ORDER BY block_number DESC, log_index DESC LIMIT 25`,
          [hex('0x' + '1'.repeat(40))],
        )).rows[0]['QUERY PLAN']);
        await c.query('ROLLBACK');
        expect(plan).toContain('"Scan Direction":"Backward"');
        expect(plan).toContain('from_id_block_number_log_index_idx');
        expect(plan).not.toContain('"Node Type":"Sort"');
      } finally {
        c.release();
      }
    });

    it('address_indexes is fixed for the schema; a schema from before the key counts as false', async () => {
      // beforeEach bootstrapped SCHEMA with META, which has no address_indexes:
      // the shape of a schema created before the key existed
      const on = createStore(SCHEMA, defs, 1000, undefined, true);
      await expect(
        bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...on.tables.values()], { ...META, address_indexes: 'true' }),
      ).rejects.toBeInstanceOf(LayoutError);
      await bootstrap(pool, SCHEMA, buildControlTables(SCHEMA), [...store.tables.values()], { ...META, address_indexes: 'false' });
      const meta = await pool.query(`SELECT value FROM ${SCHEMA}._meta WHERE key = 'address_indexes'`);
      expect(meta.rows).toEqual([{ value: 'false' }]);
      // and the other way round: created with true, asked for false
      await fresh();
      const off = createStore(S, defs, 1000);
      await expect(
        bootstrap(pool, S, buildControlTables(S), [...off.tables.values()], { ...META, address_indexes: 'false' }),
      ).rejects.toBeInstanceOf(LayoutError);
    });
  });
});
