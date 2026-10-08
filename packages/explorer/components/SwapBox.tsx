import { shortHash } from '../lib/format.js';
import type { SwapView } from '../lib/txstory.js';

export function SwapBox({ view }: { view: SwapView }) {
  if (!view.known) {
    return <p className="fig">A swap in pool {shortHash(view.pool)}, whose creation is not in the archive: its currencies are unknown.</p>;
  }
  return (
    <div className="swapbox">
      <div className="side">
        <div className="k">Paid into pool</div>
        <div className="n">{view.paid?.amount ?? '—'}</div>
        <div className="t">{view.paid?.token ?? ''}</div>
      </div>
      <div className="arrow" aria-hidden="true">
        ⇄
      </div>
      <div className="side right">
        <div className="k">Received from pool</div>
        <div className="n">{view.received?.amount ?? '—'}</div>
        <div className="t">
          {view.received?.token ?? ''} · pool fee {view.fee}
        </div>
      </div>
    </div>
  );
}
