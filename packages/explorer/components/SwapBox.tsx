import { Fragment } from 'react';
import { shortHash } from '../lib/format.js';
import type { SwapSide, SwapView } from '../lib/txstory.js';

// A long amount (a raw integer when the token's decimals are unknown) is set
// smaller and may wrap, but only after a comma, never inside a digit group.
function Amount({ side }: { side: SwapSide | null }) {
  if (!side) return <div className="n">—</div>;
  const groups = side.amount.split(',');
  return (
    <div className={side.amount.length > 16 ? 'n long' : 'n'}>
      {groups.map((g, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              ,<wbr />
            </>
          )}
          {g}
        </Fragment>
      ))}
    </div>
  );
}

export function SwapBox({ view }: { view: SwapView }) {
  if (!view.known) {
    return <p className="fig">A swap in pool {shortHash(view.pool)}, whose creation is not in the archive: its currencies are unknown.</p>;
  }
  return (
    <div className="swapbox">
      <div className="side">
        <div className="k">Paid into pool</div>
        <Amount side={view.paid} />
        <div className="t">{view.paid?.note ?? ''}</div>
      </div>
      <div className="arrow" aria-hidden="true">
        ⇄
      </div>
      <div className="side right">
        <div className="k">Received from pool</div>
        <Amount side={view.received} />
        <div className="t">{[view.received?.note, `pool fee ${view.fee}`].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}
