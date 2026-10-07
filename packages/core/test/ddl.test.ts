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
    expect(pgTypeFor('address')).toBe('integer');
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

describe('buildEventTable (dense layout 2)', () => {
  const transfer = extractEventDefs('usdc', ADDR, TRANSFER_ABI)[0]!;
  const spec = buildEventTable('idx_x', transfer);

  it('keeps only per-log columns and stores addresses as ids', () => {
    expect(spec.columns).toEqual([
      { name: 'block_number', pgType: 'bigint' },
      { name: 'tx_hash', pgType: 'bytea' },
      { name: 'log_index', pgType: 'integer' },
      { name: 'from_id', pgType: 'integer', address: true },
      { name: 'to_id', pgType: 'integer', address: true },
      { name: 'value', pgType: 'numeric(78,0)' },
    ]);
    const create = spec.statements[0]!;
    for (const gone of ['block_time', 'tx_index', '_ingested_at', 'block_hash', 'contract_address']) {
      expect(create).not.toContain(gone);
    }
    expect(create).toContain('"from_id" integer');
    expect(create).toContain('PRIMARY KEY (block_number, log_index)');
    expect(create).toMatch(/PARTITION BY RANGE \(block_number\)$/);
  });

  it('indexes tx_hash with a btree and indexed addresses by id', () => {
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_tx_hash_idx" ON "idx_x"."usdc_transfer" (tx_hash)',
    );
    expect(spec.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "usdc_transfer_from_id_idx" ON "idx_x"."usdc_transfer" ("from_id")',
    );
    expect(spec.statements.some((x) => x.includes('"value"') && x.startsWith('CREATE INDEX'))).toBe(false);
  });

  it('the _hex view reads like the old rows: block time, ingest time and 0x addresses', () => {
    const view = spec.statements.find((s) => s.startsWith('CREATE OR REPLACE VIEW'))!;
    expect(view).toBe(
      'CREATE OR REPLACE VIEW "idx_x"."usdc_transfer_hex" AS SELECT t."block_number", b."block_time", ' +
        `'0x' || encode(t."tx_hash", 'hex') AS "tx_hash", t."log_index", b."_ingested_at", ` +
        `'0x' || encode(a0."address", 'hex') AS "from", '0x' || encode(a1."address", 'hex') AS "to", t."value" ` +
        'FROM "idx_x"."usdc_transfer" t JOIN "idx_x"."_blocks" b ON b."block_number" = t."block_number" ' +
        'LEFT JOIN "idx_x"."_addresses" a0 ON a0."id" = t."from_id" ' +
        'LEFT JOIN "idx_x"."_addresses" a1 ON a1."id" = t."to_id"',
    );
  });

  it('refuses a table whose partitions could not be named', () => {
    const long = extractEventDefs('a'.repeat(30), `0x${'ab'.repeat(20)}`, [{
      type: 'event', name: 'B'.repeat(27), inputs: [],
    }])[0]!;
    expect(() => buildEventTable('idx_x', long)).toThrow(NamingError);
  });
});

describe('buildControlTables (dense layout 2)', () => {
  const s = buildControlTables('idx_x');
  it('schema, cursor, meta and dead letters', () => {
    expect(s[0]).toBe('CREATE SCHEMA IF NOT EXISTS "idx_x"');
    expect(s.some((x) => x.includes('"idx_x"._cursor'))).toBe(true);
    expect(s.some((x) => x.includes('"idx_x"._meta'))).toBe(true);
    expect(s.some((x) => x.includes('"idx_x"._dead_letter'))).toBe(true);
  });
  it('_blocks carries block time and ingest time; _addresses stores each address once', () => {
    const blocks = s.find((x) => x.includes('"idx_x"._blocks'))!;
    expect(blocks).toContain('block_hash bytea NOT NULL');
    expect(blocks).toContain('PRIMARY KEY (block_number)');
    expect(blocks).toContain('block_time timestamptz NOT NULL');
    expect(blocks).toContain('_ingested_at timestamptz NOT NULL DEFAULT now()');
    expect(blocks).toMatch(/PARTITION BY RANGE \(block_number\)$/);
    const addresses = s.find((x) => x.includes('"idx_x"._addresses'))!;
    expect(addresses).toContain('id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(addresses).toContain('address bytea NOT NULL UNIQUE');
    expect(addresses).not.toContain('PARTITION');
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
    expect(cols.map((c) => c.name)).toEqual(['param_block_number', 'arg1_id']);
    expect(cols.map((c) => c.viewName)).toEqual(['param_block_number', 'arg1']);
  });
});

describe('buildEventTable (event parameter names)', () => {
  it('two parameters that would name the same view column are refused', () => {
    const abi = [{
      type: 'event', name: 'Dup',
      inputs: [
        { name: 'foo', type: 'address', indexed: false },
        { name: 'Foo', type: 'uint256', indexed: false },
      ],
    }];
    const [def] = extractEventDefs('x', ADDR, abi);
    expect(() => eventColumns(def!.event)).toThrow(DdlError);
  });

  it('an address named like another parameter plus Id collides on the stored name', () => {
    const abi = [{
      type: 'event', name: 'Dup',
      inputs: [
        { name: 'from', type: 'address', indexed: false },
        { name: 'fromId', type: 'uint256', indexed: false },
      ],
    }];
    const [def] = extractEventDefs('x', ADDR, abi);
    expect(() => eventColumns(def!.event)).toThrow(DdlError);
  });

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

describe('buildInsightsTables (labels)', () => {
  const s = buildInsightsTables('idx_x');
  it('keeps sentences once', () => {
    const sentences = s.find((x) => x.includes('"idx_x"._sentences'))!;
    expect(sentences).toContain('UNIQUE (sentence, model)');
  });
  it('stores each label once and keeps rows to key, lane and label id', () => {
    const labels = s.find((x) => x.includes('"idx_x"._labels'))!;
    expect(labels).toContain('UNIQUE NULLS NOT DISTINCT (lane, lane_p, ruled, protocol, facts, sentence_id)');
    const insights = s.find((x) => x.includes('"idx_x"."_insights" ('))!;
    expect(insights).toContain('PRIMARY KEY (block_number, log_index)');
    expect(insights).toContain('label_id integer NOT NULL');
    expect(insights).toMatch(/PARTITION BY RANGE \(block_number\)$/);
    for (const gone of ['lane_p', 'ruled', 'protocol', 'facts', 'sentence_id', 'classified_at', 'tx_hash', 'table_name']) {
      expect(insights).not.toContain(gone);
    }
  });
  it('indexes lanes for "latest of a lane" and offers a joined view', () => {
    expect(s).toContain('CREATE INDEX IF NOT EXISTS "_insights_lane_idx" ON "idx_x"."_insights" (lane, block_number)');
    const view = s.find((x) => x.startsWith('CREATE OR REPLACE VIEW "idx_x"."_insights_full"'))!;
    expect(view).toContain('_labels');
    expect(view).not.toContain('classified_at');
  });
});
