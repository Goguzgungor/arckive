import { Masthead } from '../components/Masthead.js';
import { Status } from '../components/Status.js';

export default function NotFound() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <main className="empty">
        <div className="crumb">Not found</div>
        <h1>Nothing here.</h1>
        <p className="sub">Search a transaction hash or an address above.</p>
      </main>
    </>
  );
}
