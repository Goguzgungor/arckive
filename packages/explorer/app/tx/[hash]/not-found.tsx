import Link from 'next/link';
import { Dateline } from '../../../components/Dateline.js';
import { Masthead } from '../../../components/Masthead.js';
import { Status } from '../../../components/Status.js';
import { fmtDateLong } from '../../../lib/format.js';

export default function TxNotFound() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <main className="empty">
        <nav className="crumb">
          <Link href="/">The tape</Link> &nbsp;›&nbsp; Transaction
        </nav>
        <h1>Arckive has no USDC or Uniswap v4 event in this transaction.</h1>
        <p className="sub">It may be newer than the archive, or it moved neither USDC nor a Uniswap v4 pool. Search another transaction hash or an address above.</p>
      </main>
    </>
  );
}
