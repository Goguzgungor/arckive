import { describe, expect, it } from 'vitest';
import {
  DdlError,
  NamingError,
  buildControlTables,
  buildEventTable,
  buildInsightsTables,
  eventColumns,
  extractEventDefs,
  pgTypeFor,
} from '../src/index.js';

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER_ABI = [
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
];

describe('pgTypeFor', () => {
  it('maps types according to layout 2', () => {
    expect(pgTypeFor('address')).toBe('bytea');
    expect(pgTypeFor('bytes32')).toBe('bytea');
    expect(pgTypeFor('bytes')).toBe('bytea');
    expect(pgTypeFor('uint256')).toBe('numeric(78,0)');
    expect(pgTypeFor('int24')).toBe('numeric(78,0)');
    expect(pgTypeFor('bool')).toBe('boolean');
    expect(pgTypeFor('string')).toBe('text');
    expect(pgTypeFor('uint256[]')).toBe('jsonb');
    expect(pgTypeFor('tuple')).toBe('jsonb');
  });

  it('unknown type throws DdlError', () => {
    expect(() => pgTypeFor('fixed128x18')).toThrow(DdlError);
  });
});

describe('buildEventTable (layout 2)', () => {
  const transfer = extractEventDefs('usdc', ADDR, TRANSFER_ABI)[0]!;
  const spec = buildEventTable('idx_x', transfer);

  it('lists the columns a row supplies, in insert order', () => {
    expect(spec.columns).toEqual([
      { name: 'block_number', pgType: 'bigint' },
      { name: 'block_time', pgType: 'timestamptz' },
      { name: 'tx_hash', pgType: 'bytea' },
      { name: 'tx_index', pgType: 'integer' },
      { name: 'log_index', pgType: 'integer' },
      { name: 'from', pgType: 'bytea' },
      { name: 'to', pgType: 'bytea' },
      { name: 'value', pgType: 'numeric(78,0)' },
    ]);
  });

  it('creates a partitioned table keyed by (block_number, log_index), without block_hash or contract_address', () => {
    const create = spec.statements[0]!;
    expect(create).toContain('CREATE TABLE IF NOT EXISTS "idx_x"."usdc_transfer"');
    expect(create).toContain('"tx_hash" bytea NOT NULL');
    expect(create).toContain('"_ingested_at" timestamptz NOT NULL DEFAULT now()');
    expect(create).toContain('PRIMARY KEY (block_number, log_index)');
    expect(create).toMatch(/\) PARTITION BY RANGE \(block_number\)$/);
    expect(create).not.toContain('block_hash');
    expect(create).not.toContain('contract_address');
  });

  it('indexes tx_hash with a hash index and indexed params with btree', () => {
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_tx_hash_idx" ON "idx_x"."usdc_transfer" USING hash (tx_hash)',
    );
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_from_idx" ON "idx_x"."usdc_transfer" ("from")',
    );
    expect(spec.statements.some((s) => s.includes('"usdc_transfer_value_idx"'))).toBe(false);
  });

  it('adds a _hex view that prints bytea as 0x text', () => {
    const view = spec.statements.find((s) => s.startsWith('CREATE OR REPLACE VIEW'))!;
    expect(view).toBe(
      'CREATE OR REPLACE VIEW "idx_x"."usdc_transfer_hex" AS SELECT "block_number", "block_time", ' +
        `'0x' || encode("tx_hash", 'hex') AS "tx_hash", "tx_index", "log_index", "_ingested_at", ` +
        `'0x' || encode("from", 'hex') AS "from", '0x' || encode("to", 'hex') AS "to", "value" ` +
        'FROM "idx_x"."usdc_transfer"',
    );
  });

  it('refuses a table whose partitions could not be named', () => {
    const long = extractEventDefs('a'.repeat(30), `0x${'ab'.repeat(20)}`, [{
      type: 'event', name: 'B'.repeat(27), inputs: [],
    }])[0]!;
    expect(() => buildEventTable('idx_x', long)).toThrow(NamingError);
  });
});

describe('buildControlTables (layout 2)', () => {
  it('schema, cursor, meta, dead letters and a partitioned _blocks', () => {
    const s = buildControlTables('idx_x');
    expect(s[0]).toBe('CREATE SCHEMA IF NOT EXISTS "idx_x"');
    expect(s.some((x) => x.includes('"idx_x"._cursor'))).toBe(true);
    expect(s.some((x) => x.includes('"idx_x"._meta'))).toBe(true);
    expect(s.some((x) => x.includes('"idx_x"._dead_letter'))).toBe(true);
    const blocks = s.find((x) => x.includes('"idx_x"._blocks'))!;
    expect(blocks).toContain('block_hash bytea NOT NULL');
    expect(blocks).toContain('PRIMARY KEY (block_number)');
    expect(blocks).toMatch(/PARTITION BY RANGE \(block_number\)$/);
  });
});

describe('eventColumns', () => {
  it('parameter colliding with a common column gets a param_ prefix; unnamed parameter becomes argN', () => {
    const abi = [
      {
        type: 'event', name: 'Weird',
        inputs: [
          { name: 'blockNumber', type: 'uint256', indexed: false },
          { name: '', type: 'address', indexed: false },
        ],
      },
    ];
    const [def] = extractEventDefs('x', ADDR, abi);
    const cols = eventColumns(def!.event);
    expect(cols.map((c) => c.name)).toEqual(['param_block_number', 'arg1']);
  });
});

describe('buildEventTable (event parameter names)', () => {
  it('event parameter named _ingestedAt does not collide with the meta column (becomes ingested_at)', () => {
    const abi = [
      {
        type: 'event',
        name: 'Weird',
        inputs: [{ name: '_ingestedAt', type: 'uint256', indexed: false }],
      },
    ];
    const [def] = extractEventDefs('x', ADDR, abi);
    // toSnakeCase strips the leading _; the result differs from the DB meta column "_ingested_at"
    expect(eventColumns(def!.event).map((c) => c.name)).toEqual(['ingested_at']);
    expect(buildEventTable('idx_x', def!).columns.map((c) => c.name)).toContain('ingested_at');
  });
});

describe('buildInsightsTables (layout 2)', () => {
  const s = buildInsightsTables('idx_x');
  it('keeps one row per event, keyed like the events, and sentences once', () => {
    const sentences = s.find((x) => x.includes('"idx_x"._sentences'))!;
    expect(sentences).toContain('UNIQUE (sentence, model)');
    const insights = s.find((x) => x.includes('"idx_x"."_insights" ('))!;
    expect(insights).toContain('PRIMARY KEY (block_number, log_index)');
    expect(insights).toContain('facts text[] NOT NULL');
    expect(insights).toContain('sentence_id integer NOT NULL');
    expect(insights).toMatch(/PARTITION BY RANGE \(block_number\)$/);
    expect(insights).not.toContain('tx_hash');
    expect(insights).not.toContain('table_name');
  });
  it('indexes lanes for "latest of a lane" and offers a joined view', () => {
    expect(s).toContain('CREATE INDEX IF NOT EXISTS "_insights_lane_idx" ON "idx_x"."_insights" (lane, block_number)');
    expect(s.some((x) => x.startsWith('CREATE OR REPLACE VIEW "idx_x"."_insights_full"'))).toBe(true);
  });
});
