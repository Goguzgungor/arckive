import Link from 'next/link';
import type { ReactNode } from 'react';
import { SearchBox } from './SearchBox.js';

export function Masthead({ query = '', status }: { query?: string; status: ReactNode }) {
  return (
    <header className="mast">
      <Link href="/" className="mark">
        arckive <span>explorer</span>
      </Link>
      <SearchBox initial={query} />
      <div className="net">{status}</div>
    </header>
  );
}
