import { Fragment } from 'react';
import type { Part } from '../lib/parts.js';
import { Addr } from './Addr.js';

export function Parts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{typeof p === 'string' ? p : 'b' in p ? <b>{p.b}</b> : <Addr address={p.addr} />}</Fragment>
      ))}
    </>
  );
}
