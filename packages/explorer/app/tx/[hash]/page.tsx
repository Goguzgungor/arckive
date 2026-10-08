import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Addr } from '../../../components/Addr.js';
import { Dateline } from '../../../components/Dateline.js';
import { Flow } from '../../../components/Flow.js';
import { LanePanel } from '../../../components/LanePanel.js';
import { LaneTag } from '../../../components/LaneTag.js';
import { Masthead } from '../../../components/Masthead.js';
import { Parts } from '../../../components/Parts.js';
import { Status } from '../../../components/Status.js';
import { SwapBox } from '../../../components/SwapBox.js';
import { fmtDateLong, fmtDateTime, fmtInt, shortHash } from '../../../lib/format.js';
import { liveState } from '../../../lib/live.js';
import { readyRuntime } from '../../../lib/runtime.js';
import { decodeParam, parseTxHash } from '../../../lib/search.js';
import { laneOrder, loadLane, loadTx } from '../../../lib/tx.js';
import {
  eventRows, flowView, legsLabel, swapView, tokenAddresses, txFacts, txHeadline, txPath, type EventRow,
} from '../../../lib/txstory.js';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ hash: string }> };

// event kinds borrow a lane's ink
const KIND_INK: Record<EventRow['kind'], string> = {
  Transfer: 'payment', Swap: 'swap', Liquidity: 'liquidity', Donate: 'vault', Initialize: 'issuance',
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const hash = parseTxHash(decodeParam((await params).hash));
  return { title: hash ? `Transaction ${shortHash(hash)} · Arckive Explorer` : 'Arckive Explorer' };
}

export default async function TxPage({ params }: Props) {
  const hash = parseTxHash(decodeParam((await params).hash));
  if (!hash) notFound();
  const rt = readyRuntime();
  const tx = await loadTx(rt.pool, rt.t, hash);
  if (!tx) notFound();
  const [tokens, lane] = await Promise.all([
    rt.tokens.get(tokenAddresses(tx)),
    loadLane(rt.pool, rt.t, rt.insights, tx.block, laneOrder(tx)),
  ]);
  const flow = flowView(tx.transfers);
  const facts = txFacts(tx);
  return (
    <>
      <Masthead query={hash} status={<Status state={liveState(rt.head?.time ?? null, Date.now())} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <nav className="crumb">
        <Link href="/">The tape</Link> &nbsp;›&nbsp; Transaction
      </nav>
      <h1>
        <Parts parts={txHeadline(tx)} />
      </h1>
      <p className="sub">
        <Parts parts={txPath(tx, tokens)} />
      </p>
      <div className="cols">
        <section>
          {tx.transfers.length > 0 && (
            <>
              <h2>
                How the money moved <span>{legsLabel(tx)}</span>
              </h2>
              {flow && <Flow flow={flow} />}
              <p className="fig">
                Fig. 1 — every USDC movement in this transaction, in log order. Arckive indexes USDC and Uniswap v4 events only; gas and other tokens are not shown.
              </p>
            </>
          )}
          {tx.swaps.map((s) => (
            <SwapBox key={s.li} view={swapView(s, tx.pools[s.pool], tokens)} />
          ))}
          <h2 className="gap">
            Events in this transaction <span>as logged on chain</span>
          </h2>
          <div className="events">
            {eventRows(tx).map((e) => (
              <div className="ev" key={e.li}>
                <span className="li">#{e.li}</span>
                <LaneTag lane={KIND_INK[e.kind]} label={e.kind} />
                <span className="who">
                  <Parts parts={e.parts} />
                </span>
                <span className="a">{e.amount ?? ''}</span>
              </div>
            ))}
          </div>
        </section>
        <aside>
          <h2>Lane</h2>
          {/* key: client-side navigation between transactions reuses the component, whose state is read once from `initial` */}
          <LanePanel key={hash} hash={hash} initial={lane} />
          <h2 className="gap">Facts</h2>
          <dl className="facts">
            <dt>Transaction</dt>
            <dd>{tx.hash}</dd>
            <dt>Block</dt>
            <dd>{fmtInt(tx.block)}</dd>
            <dt>Time</dt>
            <dd>{fmtDateTime(tx.time)}</dd>
            <dt>Protocol</dt>
            <dd>{facts.protocol}</dd>
            {facts.pool && (
              <>
                <dt>Pool</dt>
                <dd>{facts.pool}</dd>
              </>
            )}
            {facts.parties.length > 0 && (
              <>
                <dt>Parties</dt>
                <dd className="parties">
                  {facts.parties.map((a) => (
                    <Addr key={a} address={a} full />
                  ))}
                </dd>
              </>
            )}
          </dl>
        </aside>
      </div>
    </>
  );
}
