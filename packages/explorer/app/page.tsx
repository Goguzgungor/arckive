import { Dateline } from '../components/Dateline.js';
import { Masthead } from '../components/Masthead.js';
import { Status } from '../components/Status.js';
import { fmtDateLong } from '../lib/format.js';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <main className="empty">
        <h1>Arckive Explorer</h1>
      </main>
    </>
  );
}
