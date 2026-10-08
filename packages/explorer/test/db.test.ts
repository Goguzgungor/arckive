import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE, addInsightsTables, startDb, type TestDb } from './fixture/db.ts';
import { tables } from '../lib/db.js';
import { SchemaError, checkSchema, hasInsights } from '../lib/schema.js';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';

const cfg = { schema: 'idx_arc_explorer', usdcTable: 'usdc_transfer', poolPrefix: 'poolmanager_' };

describe('explorer database role (insights on)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db?.stop(); });

  it('names the same tables as the fixture', () => {
    expect(tables(cfg)).toEqual(db.t);
  });

  it("reads the worker's schema and cannot write it", async () => {
    const r = await db.explorer.query(`SELECT count(*)::int AS n FROM ${db.t.usdc}`);
    expect(r.rows[0].n).toBeGreaterThan(40);
    await expect(db.explorer.query(`INSERT INTO ${db.t.cursor} (id, last_block) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET last_block = 1`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(db.explorer.query(`CREATE TABLE ${db.t.schema}.x (a int)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('runs with a 5 s statement timeout', async () => {
    const r = await db.explorer.query('SHOW statement_timeout');
    expect(r.rows[0].statement_timeout).toBe('5s');
  });

  it('applies the role SQL again without error', async () => {
    await expect(db.admin.query(ROLE)).resolves.toBeDefined();
  });

  it('accepts the schema and sees lanes', async () => {
    await expect(checkSchema(db.explorer, db.t)).resolves.toBeUndefined();
    expect(await hasInsights(db.explorer, db.t)).toBe(true);
  });

  it('creates its own tables in schema explorer, twice', async () => {
    await ensureExplorerSchema(db.explorer);
    await ensureExplorerSchema(db.explorer);
    const r = await db.explorer.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'explorer' ORDER BY 1`);
    expect(r.rows.map((x) => x.table_name)).toEqual(['address_daily', 'rollup_cursor', 'tokens']);
  });

  it('refuses a schema that lacks a column, naming it', async () => {
    await db.admin.query(`CREATE SCHEMA idx_broken`);
    await db.admin.query(`CREATE TABLE idx_broken.usdc_transfer (block_number bigint, tx_hash bytea, log_index int, from_id int, to_id int)`);
    const broken = tables({ ...cfg, schema: 'idx_broken' });
    await expect(checkSchema(db.admin, broken)).rejects.toThrow(SchemaError);
    await expect(checkSchema(db.admin, broken)).rejects.toThrow(/usdc_transfer\.value/);
    await expect(checkSchema(db.admin, broken)).rejects.toThrow(/poolmanager_swap\b/);
  });

  it('says what to do when schema explorer is missing', async () => {
    await db.admin.query('ALTER SCHEMA explorer RENAME TO explorer_away');
    try {
      await expect(ensureExplorerSchema(db.explorer)).rejects.toThrow(/explorer-role\.sql/);
    } finally {
      await db.admin.query('ALTER SCHEMA explorer_away RENAME TO explorer');
    }
  });
});

describe('explorer database role (lanes switched on later)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb({ insights: false }); });
  afterAll(async () => { await db?.stop(); });

  it('has no lanes at first, and reads the lane tables the worker adds later', async () => {
    expect(await hasInsights(db.explorer, db.t)).toBe(false);
    await addInsightsTables(db.admin);
    expect(await hasInsights(db.explorer, db.t)).toBe(true);
    await expect(db.explorer.query(`SELECT count(*) FROM ${db.t.insightsFull}`)).resolves.toBeDefined();
  });

  it('connects with the DSN shape the Secret holds', async () => {
    const c = new pg.Client({ connectionString: db.explorerUrl });
    await c.connect();
    expect((await c.query('SELECT current_user AS u')).rows[0].u).toBe('explorer');
    await c.end();
  });
});
