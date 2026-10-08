'use client';

import { useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface ChartDay {
  x: number;
  inH: number;
  outH: number;
  date: string;
  in: string;
  out: string;
  quiet: boolean;
}

interface Props {
  days: ChartDay[];
  barWidth: number;
  pitch: number;
  width: number;
  height: number;
  mid: number;
}

// Slots start 20 units in (lib/addrstory.ts chartBars).
const LEFT = 20;

// The readout names the day under the pointer, or the one the arrow keys
// rest on; with none picked it names the latest day. A touch picks a day and
// keeps it, so it can be read with the finger lifted.
export function DayChartView({ days, barWidth, pitch, width, height, mid }: Props) {
  const [pick, setPick] = useState<number | null>(null);
  const last = days.length - 1;
  if (last < 0) return null;
  const day = days[pick ?? last]!;
  // the picked day's band hugs its bar: a two-day history has 400-unit slots
  const band = Math.min(pitch, barWidth + 14);

  const at = (e: PointerEvent<SVGSVGElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * width;
    return Math.min(last, Math.max(0, Math.floor((x - LEFT) / pitch)));
  };
  const keys: Record<string, (i: number) => number> = {
    ArrowLeft: (i) => Math.max(0, i - 1),
    ArrowRight: (i) => Math.min(last, i + 1),
    Home: () => 0,
    End: () => last,
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (e.key === 'Escape') return setPick(null);
    const move = keys[e.key];
    if (!move) return;
    e.preventDefault();
    setPick((p) => move(p ?? last));
  };

  return (
    <>
      <p className="readout" aria-live="polite">
        <span className="d">
          {day.date}
          {pick === null && <em>latest day</em>}
        </span>
        {day.quiet ? (
          <span>no movements</span>
        ) : (
          <>
            <span className="in">in<b>{day.in}</b></span>
            <span className="out">out<b>{day.out}</b></span>
            <span>USDC</span>
          </>
        )}
      </p>
      <svg
        className={pick === null ? 'chart' : 'chart picking'}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="USDC received and sent per day; arrow keys move between days"
        tabIndex={0}
        onPointerMove={(e) => setPick(at(e))}
        onPointerDown={(e) => setPick(at(e))}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setPick(null);
        }}
        onKeyDown={onKey}
        onBlur={() => setPick(null)}
      >
        {pick !== null && <rect className="band" x={days[pick]!.x - (band - barWidth) / 2} y="0" width={band} height={height} />}
        <line className="axis" x1="0" x2={width} y1={mid} y2={mid} strokeWidth="1" />
        {days.map((d, i) => (
          <g key={i} className={i === pick ? 'day on' : 'day'}>
            {d.inH > 0 && <rect className="in" x={d.x} y={mid - d.inH} width={barWidth} height={d.inH} />}
            {d.outH > 0 && <rect className="out" x={d.x} y={mid + 1} width={barWidth} height={d.outH} />}
          </g>
        ))}
        <text x="0" y="12">in</text>
        <text x="0" y={height - 4}>out</text>
      </svg>
    </>
  );
}
