'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fmtAmount, fmtTime, shortAddr } from '../lib/format.js';
import { helloPlan, homeHeadline, laneShares, lanesPaused } from '../lib/homestory.js';
import { laneMeta } from '../lib/lanes.js';
import { liveState, newestTime } from '../lib/live.js';
import { Pacer } from '../lib/pacing.js';
import { openStream } from '../lib/stream-client.js';
import type { BlockMsg, Hello, Move, StatsMsg } from '../lib/types.js';
import { Dateline } from './Dateline.js';
import { LaneTag } from './LaneTag.js';
import { Masthead } from './Masthead.js';
import { Parts } from './Parts.js';
import { Status } from './Status.js';

const TAPE_ROWS = 32;

interface Row extends Move {
  key: string;
  n: number;
  t: number;
  fresh: boolean; // arrived while the page was open: it runs the enter animation
}

const rowsOf = (b: BlockMsg, fresh: boolean): Row[] => b.moves.map((m) => ({ ...m, key: `${b.n}:${m.li}`, n: b.n, t: b.t, fresh }));
// newest first, as the tape shows them; the history a page opens with does not animate
const newestFirst = (blocks: BlockMsg[]): Row[] => blocks.flatMap((b) => rowsOf(b, false)).reverse().slice(0, TAPE_ROWS);

// Rows are links already: names here are text, not nested links.
function Who({ address, name }: { address: string; name?: string }) {
  return name ? <b>{name}</b> : <>{shortAddr(address)}</>;
}

export function HomeLive({ initial, date, initialNow }: { initial: Hello; date: string; initialNow: number }) {
  const [rows, setRows] = useState<Row[]>(() => newestFirst(initial.blocks));
  const [stats, setStats] = useState<StatsMsg | null>(initial.stats);
  const [open, setOpen] = useState(true);
  const [waiting, setWaiting] = useState(0);
  // the server's clock: hydration must render what the server did
  const [now, setNow] = useState(initialNow);
  const pacer = useRef(new Pacer<Row>());
  const offset = useRef(0); // server clock − browser clock
  const newest = useRef<{ n: number; t: number } | null>(initial.blocks.at(-1) ?? null);
  // the pointer and keyboard focus pause the tape separately: leaving with the
  // mouse must not restart a tape a focused row still holds, nor the reverse
  const hold = useRef({ hover: false, focus: false });

  useEffect(() => {
    const stop = openStream({
      hello: (h) => {
        const plan = helloPlan(h, pacer.current.isPaused);
        pacer.current.clear();
        newest.current = plan.newest;
        if (plan.replace) setRows(newestFirst(h.blocks));
        if (h.stats) setStats(h.stats);
      },
      block: (b) => {
        // a resumed stream never repeats a block, but a hello may overlap the buffer
        if (newest.current && b.n <= newest.current.n) return;
        newest.current = { n: b.n, t: b.t };
        pacer.current.push(rowsOf(b, true), performance.now());
      },
      stats: (s) => {
        offset.current = s.now - Date.now();
        setStats(s);
      },
      state: setOpen,
    });
    let raf = 0;
    const tick = (): void => {
      // reversed here, not in the updater: StrictMode runs updaters twice
      const due = pacer.current.take(performance.now()).reverse();
      if (due.length) setRows((cur) => [...due, ...cur].slice(0, TAPE_ROWS));
      setWaiting(pacer.current.isPaused ? pacer.current.waiting : 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop();
      cancelAnimationFrame(raf);
      clearInterval(clock);
    };
  }, []);

  // The newest block received, not the newest shown: a viewer hovering the
  // tape has paused it, the network has not fallen behind.
  // A backfilling archive sends few blocks, so the stats' headT (the newest
  // released block that carried a movement) keeps the state honest between them.
  const head = newestTime(newest.current?.t, stats?.headT);
  const state = liveState(head, now + offset.current, open);
  const holdTape = (why: 'hover' | 'focus', on: boolean): void => {
    hold.current[why] = on;
    if (hold.current.hover || hold.current.focus) pacer.current.pause();
    else pacer.current.resume(performance.now());
  };
  const paused = lanesPaused(stats);

  return (
    <>
      <Masthead status={<Status state={state} />} />
      <Dateline date={date} />
      <div className="head">
        <h1>
          <Parts parts={homeHeadline(stats, state.kind === 'behind' ? head : null)} />
        </h1>
        <p className="fig">Fig. 1 — the tape below is every USDC movement as it lands, each filed under the lane Laya read in its transaction.</p>
      </div>
      <div className="cols home">
        <section aria-label="The tape">
          <h2>
            The tape{' '}
            <span>
              {waiting > 0 && <span className="waiting">{waiting} new</span>} {stats ? `${stats.perSec.toFixed(1)} a second · UTC` : 'UTC'}
            </span>
          </h2>
          <div
            className="tape"
            onMouseEnter={() => holdTape('hover', true)}
            onMouseLeave={() => holdTape('hover', false)}
            // only keyboard focus: a cmd- or middle-clicked row keeps focus
            // after the pointer leaves, and must not hold the tape
            onFocus={(e) => {
              if (e.target.matches(':focus-visible')) holdTape('focus', true);
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdTape('focus', false);
            }}
          >
            {rows.length === 0 && (
              <p className="empty">
                {state.kind === 'behind' ? 'The archive is catching up; movements appear as they are indexed.' : 'Waiting for the next USDC movement…'}
              </p>
            )}
            {rows.map((r) => (
              <Link
                key={r.key}
                href={`/tx/${r.tx}`}
                prefetch={false}
                className={r.fresh ? 'row fresh' : 'row'}
                style={{ '--lane': laneMeta(r.lane).ink } as CSSProperties}
              >
                <span className="time">{fmtTime(r.t)}</span>
                <LaneTag lane={r.lane} />
                <span className="who">
                  <Who address={r.from} name={r.fromName} /> → <Who address={r.to} name={r.toName} />
                </span>
                <span className="amt">
                  {fmtAmount(r.value)}
                  <small>USDC</small>
                </span>
              </Link>
            ))}
          </div>
        </section>
        <aside>
          <h2>Largest this minute</h2>
          <div className="largest">
            {(stats?.largest ?? []).map((m) => (
              <Link key={`${m.n}:${m.li}`} href={`/tx/${m.tx}`} prefetch={false}>
                <span className="n">{fmtAmount(m.value)}</span>
                <LaneTag lane={m.lane} />
                <span className="s">
                  <Who address={m.from} name={m.fromName} /> → <Who address={m.to} name={m.toName} />
                </span>
              </Link>
            ))}
          </div>
          <div className="lanes">
            <h2>
              By lane <span>{paused ? 'lanes paused' : 'share of movements'}</span>
            </h2>
            {laneShares(stats).map((s) => (
              <div className="bar" key={s.lane}>
                <span>{s.label}</span>
                <span className="track">
                  <span style={{ width: `${s.pct}%`, background: s.ink }} />
                </span>
                <em>{s.pct}%</em>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
