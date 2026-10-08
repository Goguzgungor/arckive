'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { routeSearch } from '../lib/search.js';

export function SearchBox({ initial }: { initial: string }) {
  const router = useRouter();
  const [hint, setHint] = useState<string | null>(null);
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const v = new FormData(e.currentTarget).get('q');
    const r = routeSearch(typeof v === 'string' ? v : '');
    if ('href' in r) {
      setHint(null);
      router.push(r.href);
    } else {
      setHint(r.hint);
    }
  };
  return (
    <form className="search" role="search" onSubmit={onSubmit}>
      <input
        key={initial}
        name="q"
        defaultValue={initial}
        placeholder="Search a transaction hash or an address"
        aria-label="Search a transaction hash or an address"
        spellCheck={false}
        autoComplete="off"
      />
      {hint && (
        <p className="hint" role="status">
          {hint}
        </p>
      )}
    </form>
  );
}
