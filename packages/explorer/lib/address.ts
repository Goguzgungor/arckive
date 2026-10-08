import type pg from 'pg';
import { bytesToHex, hexToBytes, type Tables } from './db.js';

export interface AddressTotals {
  inValue: string;
  outValue: string;
  inCount: number;
  outCount: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface DayBar {
  day: string;
  inValue: string;
  outValue: string;
}

export interface HistoryRow {
  block: number;
  li: number;
  tx: string;
  time: number;
  dir: 'in' | 'out' | 'self';
  counterparty: string;
  value: string;
  lane: string | null;
}

export interface HistoryPage {
  rows: HistoryRow[];
  older: string | null; // ?before= for the next page
}

export interface Recent {
  total: number;
  counterparties: { address: string; count: number; value: string }[];
  lanes: Record<string, number>;
}

export interface Before {
  block: number;
  li: number;
}

const MAX_BLOCK = '9223372036854775807';
const MAX_LI = 2147483647;

// ?before=<block>-<log>; anything else is the first page.
export function parseBefore(s: string | undefined): Before | null {
  const m = /^(\d{1,15})-(\d{1,9})$/.exec(s ?? '');
  return m ? { block: Number(m[1]), li: Number(m[2]) } : null;
}

export async function addressId(pool: pg.Pool, t: Tables, address: string): Promise<number | null> {
  const r = await pool.query<{ id: number }>(`SELECT id FROM ${t.addresses} WHERE address = $1`, [hexToBytes(address)]);
  return r.rowCount ? r.rows[0]!.id : null;
}

// Whole-history totals from the rollup, never from scanning the transfers.
export async function totals(pool: pg.Pool, id: number): Promise<AddressTotals> {
  const r = await pool.query<{ i: string | null; o: string | null; ic: number | null; oc: number | null; f: string | null; l: string | null }>(
    `SELECT sum(in_value)::text AS i, sum(out_value)::text AS o, sum(in_count)::int AS ic, sum(out_count)::int AS oc,
            min(day)::text AS f, max(day)::text AS l
     FROM explorer.address_daily WHERE address_id = $1`,
    [id],
  );
  const x = r.rows[0]!;
  return { inValue: x.i ?? '0', outValue: x.o ?? '0', inCount: x.ic ?? 0, outCount: x.oc ?? 0, firstDay: x.f, lastDay: x.l };
}

export async function days(pool: pg.Pool, id: number): Promise<DayBar[]> {
  const r = await pool.query<{ day: string; i: string; o: string }>(
    'SELECT day::text AS day, in_value::text AS i, out_value::text AS o FROM explorer.address_daily WHERE address_id = $1 ORDER BY day',
    [id],
  );
  return r.rows.map((x) => ({ day: x.day, inValue: x.i, outValue: x.o }));
}

// The latest `limit` rows of an address before a keyset position: two index
// scans (from_id, to_id — storage.addressIndexes orders both by block and
// log) merged; UNION drops the self-transfer both scans find.
function latestSql(t: Tables, limit: string): string {
  const cols = 'block_number, log_index, tx_hash, from_id, to_id, value';
  const scan = (col: string): string =>
    `(SELECT ${cols} FROM ${t.usdc} WHERE ${col} = $1 AND (block_number, log_index) < ($2::bigint, $3::int)
      ORDER BY block_number DESC, log_index DESC LIMIT ${limit})`;
  return `WITH h AS (${scan('from_id')} UNION ${scan('to_id')}),
  page AS (SELECT * FROM h ORDER BY block_number DESC, log_index DESC LIMIT ${limit})`;
}

export async function history(pool: pg.Pool, t: Tables, lanes: boolean, id: number, before: Before | null, size = 25): Promise<HistoryPage> {
  const r = await pool.query<{ n: string; li: number; tx: Buffer; f: number; r: number; fa: Buffer; ta: Buffer; v: string; t: string; lane?: string | null }>(
    `${latestSql(t, '$4')}
     SELECT p.block_number::text AS n, p.log_index AS li, p.tx_hash AS tx, p.from_id AS f, p.to_id AS r, fa.address AS fa, ta.address AS ta,
            p.value::text AS v, extract(epoch from b.block_time)::bigint::text AS t${lanes ? ', i.lane' : ''}
     FROM page p
     JOIN ${t.blocks} b ON b.block_number = p.block_number
     JOIN ${t.addresses} fa ON fa.id = p.from_id
     JOIN ${t.addresses} ta ON ta.id = p.to_id
     ${lanes ? `LEFT JOIN ${t.insights} i ON i.block_number = p.block_number AND i.log_index = p.log_index` : ''}
     ORDER BY p.block_number DESC, p.log_index DESC`,
    [id, before ? String(before.block) : MAX_BLOCK, before ? before.li : MAX_LI, size + 1],
  );
  const rows = r.rows.slice(0, size).map((x): HistoryRow => {
    const dir = x.f === x.r ? 'self' : x.r === id ? 'in' : 'out';
    return {
      block: Number(x.n), li: x.li, tx: bytesToHex(x.tx), time: Number(x.t), dir,
      counterparty: bytesToHex(dir === 'in' ? x.fa : x.ta), value: x.v, lane: x.lane ?? null,
    };
  });
  const last = rows.at(-1);
  return { rows, older: r.rows.length > size && last ? `${last.block}-${last.li}` : null };
}

// Counterparties and lanes over the latest n movements, labelled so on the page.
export async function recent(pool: pg.Pool, t: Tables, lanes: boolean, id: number, n = 1000): Promise<Recent> {
  const args = [id, MAX_BLOCK, MAX_LI, n];
  const cps = await pool.query<{ a: Buffer; c: number; v: string; total: number }>(
    `${latestSql(t, '$4')}
     SELECT a.address AS a, x.c, x.v::text AS v, x.total FROM (
       SELECT CASE WHEN to_id = $1 THEN from_id ELSE to_id END AS cp, count(*)::int AS c, sum(value) AS v,
              sum(count(*)) OVER ()::int AS total
       FROM page GROUP BY 1
     ) x JOIN ${t.addresses} a ON a.id = x.cp ORDER BY x.c DESC, x.v DESC LIMIT 6`,
    args,
  );
  const out: Recent = {
    total: cps.rows[0]?.total ?? 0,
    counterparties: cps.rows.map((x) => ({ address: bytesToHex(x.a), count: x.c, value: x.v })),
    lanes: {},
  };
  if (lanes) {
    const lr = await pool.query<{ lane: string; c: number }>(
      `${latestSql(t, '$4')}
       SELECT i.lane, count(*)::int AS c FROM page p JOIN ${t.insights} i ON i.block_number = p.block_number AND i.log_index = p.log_index GROUP BY 1`,
      args,
    );
    for (const x of lr.rows) out.lanes[x.lane] = x.c;
  }
  return out;
}
