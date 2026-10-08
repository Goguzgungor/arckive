import type { CSSProperties } from 'react';
import { laneMeta } from '../lib/lanes.js';

export function LaneTag({ lane, label }: { lane: string | null; label?: string }) {
  const m = laneMeta(lane);
  return (
    <span className={lane === null ? 'tag none' : 'tag'} style={{ '--lane': m.ink } as CSSProperties}>
      <i />
      {label ?? m.label}
    </span>
  );
}
