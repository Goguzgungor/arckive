import Link from 'next/link';
import { shortAddr } from '../lib/format.js';
import { nameOf } from '../lib/names.js';

// An address as its verified name or its short form, linked to its page.
export function Addr({ address, full = false }: { address: string; full?: boolean }) {
  const name = nameOf(address);
  return (
    <Link href={`/address/${address}`} className="addr" title={address} prefetch={false}>
      {name ? <b>{name}</b> : <span className="mono">{full ? address : shortAddr(address)}</span>}
    </Link>
  );
}
