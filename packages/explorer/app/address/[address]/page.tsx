import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Addr } from '../../../components/Addr.js';
import { Dateline } from '../../../components/Dateline.js';
import { DayChart } from '../../../components/DayChart.js';
import { LaneTag } from '../../../components/LaneTag.js';
import { Masthead } from '../../../components/Masthead.js';
import { Parts } from '../../../components/Parts.js';
import { Status } from '../../../components/Status.js';
import { addressId, days, history, parseBefore, recent, totals } from '../../../lib/address.js';
import { addressHeadline, netOf, topLane } from '../../../lib/addrstory.js';
import {
  fmtAmount, fmtDateLong, fmtDay, fmtInt, fmtSigned, fmtStamp, pct, shortAddr, unitsToDecimal,
} from '../../../lib/format.js';
import { LANE_ORDER, laneMeta } from '../../../lib/lanes.js';
import { liveState } from '../../../lib/live.js';
import { readyRuntime } from '../../../lib/runtime.js';
import { decodeParam, parseAddress } from '../../../lib/search.js';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The rollup lags the worker by up to a round (2 s) in steady state; further
// behind, the totals say how far they reach.
const ROLLUP_SLACK = 120;

const usdc = (raw: string): string => fmtAmount(unitsToDecimal(raw));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = parseAddress(decodeParam((await params).address));
  return { title: address ? `Address ${shortAddr(address)} · Arckive Explorer` : 'Arckive Explorer' };
}

export default async function AddressPage({ params, searchParams }: Props) {
  const address = parseAddress(decodeParam((await params).address));
  if (!address) notFound();
  const sp = await searchParams;
  const before = parseBefore(typeof sp['before'] === 'string' ? sp['before'] : undefined);
  const rt = readyRuntime();
  const id = await addressId(rt.pool, rt.t, address);
  const tot = id === null ? null : await totals(rt.pool, id);
  const shell = (
    <>
      <Masthead query={address} status={<Status state={liveState(rt.head?.time ?? null, Date.now())} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <nav className="crumb">
        <Link href="/">The tape</Link> &nbsp;›&nbsp; Address
      </nav>
      <h1>
        <span className="mono">{address}</span>
      </h1>
    </>
  );
  if (id === null || !tot || tot.inCount + tot.outCount === 0) {
    return (
      <>
        {shell}
        <main className="empty">
          <p className="sub">No USDC movement for this address since 2026-05-15.</p>
        </main>
      </>
    );
  }
  const lanesOn = rt.insights.on;
  const [dayRows, page, rec] = await Promise.all([
    days(rt.pool, id),
    history(rt.pool, rt.t, lanesOn, id, before),
    recent(rt.pool, rt.t, lanesOn, id),
  ]);
  const behind = rt.rolledTo !== null && rt.head !== null && rt.rolledTo < rt.head.block - ROLLUP_SLACK;
  const laneTotal = Object.values(rec.lanes).reduce((a, b) => a + b, 0);
  return (
    <>
      {shell}
      <p className="sub">
        <Parts parts={addressHeadline({ address, totals: tot, topLane: topLane(rec.lanes) })} />
      </p>
      {behind && <p className="note">Totals up to block {fmtInt(rt.rolledTo!)}; later movements are still being added.</p>}
      <div className="stats">
        <div>
          <div className="k">Received · USDC</div>
          <div className="n in">{usdc(tot.inValue)}</div>
        </div>
        <div>
          <div className="k">Sent · USDC</div>
          <div className="n out">{usdc(tot.outValue)}</div>
        </div>
        <div>
          <div className="k">Net · USDC</div>
          <div className="n">{fmtSigned(netOf(tot))}</div>
        </div>
        <div>
          <div className="k">Movements</div>
          <div className="n">{fmtInt(tot.inCount + tot.outCount)}</div>
        </div>
      </div>
      <div className="cols">
        <section>
          <h2>
            In and out, day by day{' '}
            <span>
              {tot.firstDay && tot.lastDay ? `${fmtDay(tot.firstDay)} – ${fmtDay(tot.lastDay)} · UTC` : 'UTC'}
            </span>
          </h2>
          <DayChart days={dayRows} />
          <p className="fig">Fig. 1 — USDC received (above the line) and sent (below) per day, over this address’s whole history.</p>
          <h2 className="gap">
            History <span>{before ? 'older movements, newest first · UTC' : 'newest first · UTC'}</span>
          </h2>
          <div className="hist">
            {page.rows.map((r) => (
              <div className="hrow" key={`${r.block}-${r.li}`}>
                <span className="t">{fmtStamp(r.time)}</span>
                <span className={`dir ${r.dir}`}>{r.dir.toUpperCase()}</span>
                <span className="who">
                  {r.dir === 'self' ? 'to itself' : <>{r.dir === 'in' ? 'from ' : 'to '}<Addr address={r.counterparty} /></>}
                </span>
                <LaneTag lane={r.lane} />
                <span className="a">{usdc(r.value)}</span>
                <Link className="x" href={`/tx/${r.tx}`} prefetch={false}>
                  {r.tx.slice(0, 10)}…
                </Link>
              </div>
            ))}
          </div>
          <nav className="more">
            {before && <Link href={`/address/${address}`} prefetch={false}>← Newest</Link>}
            {page.older && <Link href={`/address/${address}?before=${page.older}`} prefetch={false}>Older movements →</Link>}
          </nav>
        </section>
        <aside>
          <h2>
            Most frequent counterparties <span>latest {fmtInt(rec.total)}</span>
          </h2>
          <div className="cp">
            {rec.counterparties.map((c) => (
              <div className="cpr" key={c.address}>
                <span className="w">
                  <Addr address={c.address} />
                </span>
                <span className="n">{usdc(c.value)}</span>
                <span className="s">
                  {fmtInt(c.count)} {c.count === 1 ? 'movement' : 'movements'}
                </span>
              </div>
            ))}
          </div>
          <div className="lanes">
            <h2>
              By lane <span>latest {fmtInt(rec.total)} movements</span>
            </h2>
            {laneTotal === 0 ? (
              <p className="fig">No lanes read for these movements yet.</p>
            ) : (
              LANE_ORDER.filter((l) => (rec.lanes[l] ?? 0) > 0).map((l) => (
                <div className="bar" key={l}>
                  <span>{laneMeta(l).label}</span>
                  <span className="track">
                    <span style={{ width: `${pct(rec.lanes[l]!, rec.total)}%`, background: laneMeta(l).ink }} />
                  </span>
                  <em>{pct(rec.lanes[l]!, rec.total)}%</em>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
