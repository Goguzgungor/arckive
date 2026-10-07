import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildControlTables, extractEventDefs, type DecodedRow } from '@arckive/core';
import {
  LayoutError, Partitions, bootstrap, commitBatch, contractMeta, createStore, getCursor, initCursor, type Store,
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
    columns: {
      block_number: String(blockNumber),
      block_time: new Date('2026-07-03T00:00:00Z'),
      tx_hash: hex('0x' + 'b'.repeat(64)),
      tx_index: 0,
      log_index: logIndex,
      from: hex('0x' + '1'.repeat(40)),
      to: hex('0x' + '2'.repeat(40)),
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
    const r = await pool.query(`SELECT "from", tx_hash FROM ${SCHEMA}.usdc_transfer ORDER BY log_index`);
    expect(r.rows[0].from).toEqual(hex('0x' + '1'.repeat(40)));
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
      expect(small).toBe(5); // BEGIN, _blocks, usdc_transfer, cursor, COMMIT
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

  it('the _hex view prints 0x text', async () => {
    await commitBatch(pool, store, [row(10, 0)], [], 10n);
    const r = await pool.query(`SELECT "from", tx_hash FROM ${SCHEMA}.usdc_transfer_hex`);
    expect(r.rows[0]).toEqual({ from: '0x' + '1'.repeat(40), tx_hash: '0x' + 'b'.repeat(64) });
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
});
