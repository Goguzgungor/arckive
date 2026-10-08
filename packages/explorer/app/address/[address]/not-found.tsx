import Link from 'next/link';
import { Dateline } from '../../../components/Dateline.js';
import { Masthead } from '../../../components/Masthead.js';
import { Status } from '../../../components/Status.js';
import { fmtDateLong } from '../../../lib/format.js';

export default function AddressNotFound() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <main className="empty">
        <nav className="crumb">
          <Link href="/">The tape</Link> &nbsp;›&nbsp; Address
        </nav>
        <h1>That is not an address.</h1>
        <p className="sub">An address is 0x followed by 40 hexadecimal characters. Search one, or a transaction hash, above.</p>
      </main>
    </>
  );
}
