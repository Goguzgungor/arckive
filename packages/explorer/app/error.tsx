'use client';

import { Masthead } from '../components/Masthead.js';
import { Status } from '../components/Status.js';

// Shown when the database does not answer (or a query passes the role's 5 s
// statement timeout). Next sets the status code of a failed render; the API
// routes answer 503.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <Masthead status={<Status state={{ kind: 'down' }} />} />
      <main className="empty">
        <div className="crumb">Service unavailable</div>
        <h1>The archive is not answering; the tape will resume on its own.</h1>
        <p className="sub">
          Arckive’s database did not reply in time.{' '}
          <button type="button" className="linklike" onClick={reset}>
            Try again
          </button>
        </p>
      </main>
    </>
  );
}
