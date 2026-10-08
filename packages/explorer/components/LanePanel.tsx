'use client';

import { useEffect, useState } from 'react';
import { dayOf, fmtDay } from '../lib/format.js';
import type { LaneState } from '../lib/types.js';
import { LaneTag } from './LaneTag.js';

const POLL_MS = 2000;
const POLLS = 15; // 30 s

export function LanePanel({ hash, initial }: { hash: string; initial: LaneState }) {
  const [lane, setLane] = useState(initial);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (lane.kind !== 'pending') return;
    let polls = 0;
    const id = setInterval(async () => {
      polls++;
      try {
        const r = await fetch(`/api/tx/${hash}/lane`, { cache: 'no-store' });
        if (r.ok) {
          const next = ((await r.json()) as { lane: LaneState }).lane;
          if (next.kind !== 'pending') {
            setLane(next);
            clearInterval(id);
            return;
          }
        }
      } catch {
        // the next poll tries again
      }
      if (polls >= POLLS) {
        clearInterval(id);
        setGaveUp(true);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [hash, lane.kind]);

  switch (lane.kind) {
    case 'read':
      return (
        <div>
          <LaneTag lane={lane.lane} /> <span className="conf">· {lane.p === null ? 'ruled' : lane.p.toFixed(2)}</span>
          <p className="why">
            {lane.why} <em>Laya read: “{lane.sentence}”</em>
          </p>
        </div>
      );
    case 'pending':
      return <p className="why">{gaveUp ? 'Laya has not read this transaction yet; reload in a while.' : 'Laya is reading this transaction…'}</p>;
    case 'before':
      return <p className="why">Arckive began reading lanes on {fmtDay(dayOf(lane.since))}; this transaction is older.</p>;
    case 'none':
      return <p className="why">Laya has no lane for this transaction.</p>;
    case 'off':
      return <p className="why">Lanes are not being read on this archive yet.</p>;
  }
}
