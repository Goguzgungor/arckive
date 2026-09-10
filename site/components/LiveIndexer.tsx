"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const START_HEAD = 8_123_456;
const BACKFILL_FROM = 8_101_338;

export type Phase = "provisioning" | "backfilling" | "live";
export type Row = {
  bn: number;
  from: string;
  to: string;
  value: string;
  ms: number;
};

type Live = { phase: Phase; current: number; head: number; rows: Row[] };

const LiveContext = createContext<Live>({
  phase: "provisioning",
  current: BACKFILL_FROM,
  head: START_HEAD,
  rows: [],
});

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(seed: number) {
  const rng = mulberry32(seed);
  const hex = (n: number) =>
    Array.from({ length: n }, () =>
      "0123456789abcdef".charAt(Math.floor(rng() * 16))
    ).join("");
  const addr = () => `0x${hex(4)}…${hex(4)}`;
  const value = () => {
    const v = rng() < 0.18 ? rng() * 240_000 + 10_000 : rng() * 4_800 + 12;
    return v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };
  return (bn: number): Row => ({
    bn,
    from: addr(),
    to: addr(),
    value: value(),
    ms: Math.round(360 + rng() * 90),
  });
}

export const fmt = (n: number) => n.toLocaleString("en-US");

// One simulated indexer for the whole page: the hero status table and the
// "Latest events" cards read the same clock, so they never drift apart.
export function LiveIndexerProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("provisioning");
  const [current, setCurrent] = useState(BACKFILL_FROM);
  const [head, setHead] = useState(START_HEAD);
  const [rows, setRows] = useState<Row[]>([]);
  const genRef = useRef(makeGen(20260701));

  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(setTimeout(() => alive && fn(), ms));
    };
    const gen = genRef.current;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setPhase("live");
      setCurrent(START_HEAD);
      setRows(Array.from({ length: 4 }, (_, i) => gen(START_HEAD - i)));
      return;
    }

    later(() => setPhase("backfilling"), 900);
    const STEPS = 26;
    for (let i = 1; i <= STEPS; i++) {
      const e = 1 - Math.pow(1 - i / STEPS, 3);
      later(
        () =>
          setCurrent(
            Math.round(BACKFILL_FROM + (START_HEAD - BACKFILL_FROM) * e)
          ),
        900 + i * 95
      );
    }

    later(() => {
      setPhase("live");
      setRows([gen(START_HEAD)]);
      let h = START_HEAD;
      const tick = setInterval(() => {
        if (!alive) return;
        h += 1;
        setHead(h);
        setCurrent(h);
        setRows((r) => [gen(h), ...r].slice(0, 4));
      }, 1200);
      timers.push(tick as unknown as ReturnType<typeof setTimeout>);
    }, 900 + STEPS * 95 + 500);

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <LiveContext.Provider value={{ phase, current, head, rows }}>
      {children}
    </LiveContext.Provider>
  );
}

export const useLiveIndexer = () => useContext(LiveContext);
