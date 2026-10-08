import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';
import { Rollup } from '../lib/rollup.js';
import { addressId, days, history, parseBefore, recent, totals } from '../lib/address.js';

const key = (r: { block: number; li: number }) => `${r.block}-${r.li}`;
const busyIn = R.BUSY_ROWS.filter((r) => r.to === R.BUSY);
const busyOut = R.BUSY_ROWS.filter((r) => r.from === R.BUSY);

for (const lanes of [true, false]) {
  describe(`address pages (lanes ${lanes ? 'on' : 'not yet on'})`, () => {
    let db: TestDb;
    let id: number;
    beforeAll(async () => {
      db = await startDb({ insights: lanes });
      await ensureExplorerSchema(db.explorer);
      const r = new Rollup(db.explorer, db.t);
      while ((await r.step()) === 'more');
      id = (await addressId(db.explorer, db.t, R.BUSY))!;
    });
    afterAll(async () => { await db?.stop(); });

    it('finds known addresses only', async () => {
      expect(id).toEqual(expect.any(Number));
      expect(await addressId(db.explorer, db.t, R.UNSEEN)).toBeNull();
    });

    it('totals the whole history from the rollup, a self-transfer on both sides', async () => {
      const sum = (rows: readonly R.Transfer[]) => rows.reduce((n, r) => n + BigInt(r.value), 0n).toString();
      expect(await totals(db.explorer, id)).toEqual({
        inValue: sum(busyIn), outValue: sum(busyOut), inCount: busyIn.length, outCount: busyOut.length,
        firstDay: '2026-10-07', lastDay: '2026-10-08',
      });
    });

    it('gives one bar per day', async () => {
      expect((await days(db.explorer, id)).map((d) => d.day)).toEqual(['2026-10-07', '2026-10-08']);
    });

    it('pages the history newest first with no gaps or repeats', async () => {
      const p1 = await history(db.explorer, db.t, lanes, id, null);
      expect(p1.rows).toHaveLength(25);
      expect(p1.older).toBe(key(p1.rows[24]!));
      const p2 = await history(db.explorer, db.t, lanes, id, parseBefore(p1.older!));
      expect(p2.rows).toHaveLength(R.BUSY_ROWS.length - 25);
      expect(p2.older).toBeNull();
      const seen = [...p1.rows, ...p2.rows].map(key);
      expect(new Set(seen).size).toBe(seen.length);
      expect(new Set(seen)).toEqual(new Set(R.BUSY_ROWS.map((r) => `${r.n}-${r.li}`)));
      const order = [...seen].sort((a, b) => {
        const [ab, al] = a.split('-').map(Number) as [number, number];
        const [bb, bl] = b.split('-').map(Number) as [number, number];
        return bb - ab || bl - al;
      });
      expect(seen).toEqual(order);
    });

    it('reads direction, counterparty and lane per row', async () => {
      const rows = (await history(db.explorer, db.t, lanes, id, null, 100)).rows;
      const self = rows.find((r) => r.block === R.busyBlock(15))!;
      expect(self).toMatchObject({ dir: 'self', counterparty: R.BUSY });
      const top = rows[0]!;
      expect(top).toMatchObject({ block: R.busyBlock(29), li: 1, dir: 'in', counterparty: R.CPS[0], value: R.usdc(0, 1), lane: null });
      const read = rows.find((r) => r.block === R.busyBlock(0))!;
      expect(read.lane).toBe(lanes ? 'payment' : null);
      expect(read.time).toBe(Date.UTC(2026, 9, 7, 23, 59, 40) / 1000);
    });

    it('summarises the latest movements', async () => {
      const r = await recent(db.explorer, db.t, lanes, id);
      expect(r.total).toBe(R.BUSY_ROWS.length);
      // ten movements each; ties go to the larger sum (CPS[2] 166.25, CPS[1] 156.25, CPS[0] 130.26 USDC)
      expect(r.counterparties.slice(0, 3).map((c) => [c.address, c.count])).toEqual([[R.CPS[2], 10], [R.CPS[1], 10], [R.CPS[0], 10]]);
      expect(r.counterparties[0]!.value).toBe('166250000000000000000');
      // its self-transfer counts among the movements but never as a counterparty
      expect(r.counterparties.map((c) => c.address)).toEqual([R.CPS[2], R.CPS[1], R.CPS[0]]);
      if (lanes) expect(r.lanes).toEqual({ payment: 10, signed_payment: 10 });
      else expect(r.lanes).toEqual({});
    });

    it('counts an address whose only movement is to itself, with no counterparty', async () => {
      const self = (await addressId(db.explorer, db.t, R.SELF))!;
      expect(await recent(db.explorer, db.t, lanes, self)).toMatchObject({ total: 1, counterparties: [] });
    });
  });
}

describe('parseBefore', () => {
  it('reads a keyset cursor and ignores anything else', () => {
    expect(parseBefore('24861160-1')).toEqual({ block: 24861160, li: 1 });
    for (const s of [undefined, '', 'abc', '1-2-3', '-1-0', '1-', '99999999999999999999-0']) expect(parseBefore(s)).toBeNull();
  });
});
