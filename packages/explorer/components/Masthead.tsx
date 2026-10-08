import Link from 'next/link';
import type { ReactNode } from 'react';
import { SearchBox } from './SearchBox.js';
import { ThemeToggle } from './ThemeToggle.js';

export function Masthead({ query = '', status }: { query?: string; status: ReactNode }) {
  return (
    <header className="mast">
      <Link href="/" className="mark">
        arckive <span>explorer</span>
      </Link>
      <SearchBox initial={query} />
      <div className="net">
        {status}
        <ThemeToggle />
      </div>
    </header>
  );
}
