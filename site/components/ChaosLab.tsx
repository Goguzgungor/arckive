"use client";

import { useEffect, useRef, useState } from "react";

const START = 8_123_456;
const fmt = (n: number) => n.toLocaleString("en-US");

type LogLine = { t: string; text: string; cls?: string };
type Scenario = "rpc" | "worker" | null;

export default function ChaosLab() {
  const [head, setHead] = useState(START);
  const [cursor, setCursor] = useState(START);
  const [primary, setPrimary] = useState<"up" | "down">("up");
  const [backup, setBackup] = useState<"standby" | "up">("standby");
  const [worker, setWorker] = useState<"up" | "down">("up");
  const [busy, setBusy] = useState<Scenario>(null);
  const [log, setLog] = useState<LogLine[]>([
    {
      t: "t+0.0s",
      text: "usdc-arc · phase=Live · cursor=head · lag=0 · gaps=0",
      cls: "ok",
    },
  ]);

  const clock = useRef(0);
  const catchingUp = useRef(false);
  const logBox = useRef<HTMLDivElement>(null);

  const stamp = () => `t+${clock.current.toFixed(1)}s`;
  const push = (text: string, cls?: string) =>
    setLog((l) => [...l.slice(-50), { t: stamp(), text, cls }]);

  // the chain never stops; ingestion follows when it can
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const TICK = reduced ? 1600 : 650;
    const id = setInterval(() => {
      clock.current += TICK / 1000;
      setHead((h) => {
        const nh = h + 1;
        const ingesting =
          worker === "up" && (primary === "up" || backup === "up");
        if (ingesting) {
          setCursor((c) => {
            const lag = nh - c;
            const nc = lag > 1 ? c + Math.min(lag, 4) : nh;
            if (lag > 1 && nc >= nh && catchingUp.current) {
              catchingUp.current = false;
              push("caught up — cursor = head, lag 0, gaps 0", "ok");
              // heal the pool quietly so the demo can run again
              setTimeout(() => {
                setPrimary("up");
                setBackup("standby");
                setWorker("up");
                setBusy(null);
              }, 900);
            }
            return Math.min(nc, nh);
          });
        }
        return nh;
      });
    }, TICK);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker, primary, backup]);

  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const later = (fn: () => void, ms: number) => setTimeout(fn, ms);

  const killRpc = () => {
    if (busy || primary === "down") return;
    setBusy("rpc");
    setPrimary("down");
    push("rpc-primary.arc: timeout — retry 1/3 · 2/3 · 3/3 failed", "err");
    later(() => push("circuit open for rpc-primary.arc — rotating pool", "warn"), 900);
    later(() => {
      setBackup("up");
      push("failover → rpc-backup.arc (chainId ok · head advancing)", "ok");
      catchingUp.current = true;
    }, 2100);
  };

  const crashWorker = () => {
    if (busy || worker === "down") return;
    setBusy("worker");
    setWorker("down");
    push("pod arckive-worker-usdc-arc-7d4f9 deleted (chaos)", "err");
    later(
      () => push("reconcile: desired replicas 1, observed 0 — creating pod", "dim"),
      1100
    );
    later(() => {
      setWorker("up");
      push("worker up — resume from checkpoint cursor (kept in postgres)", "ok");
      catchingUp.current = true;
    }, 2600);
  };

  const lag = head - cursor;

  return (
    <div className="chaos">
      <div className="chaos-head">
        <b>Chaos lab — try to lose data</b>
        <span className="simulated">
          <span className="dot on" />
          simulated
        </span>
      </div>

      <div className="chips">
        <span className={`chip ${primary === "up" ? "up" : "down"}`}>
          <span className="led" />
          rpc-primary.arc
        </span>
        <span className={`chip ${backup === "up" ? "up" : "standby"}`}>
          <span className="led" />
          rpc-backup.arc
        </span>
        <span className={`chip ${worker === "up" ? "up" : "down"}`}>
          <span className="led" />
          worker pod
        </span>
      </div>

      <div className="tiles">
        <div className="tile">
          <small>chain head</small>
          <b>{fmt(head)}</b>
        </div>
        <div className="tile">
          <small>cursor</small>
          <b>{fmt(cursor)}</b>
        </div>
        <div className="tile">
          <small>lag</small>
          <b className={lag > 0 ? "warn" : "ok"}>{fmt(lag)}</b>
        </div>
        <div className="tile">
          <small>gaps</small>
          <b className="ok">0</b>
        </div>
      </div>

      <div className="chaos-controls">
        <button
          type="button"
          className="chaos-btn"
          onClick={killRpc}
          disabled={busy !== null || primary === "down"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
          Kill primary RPC
        </button>
        <button
          type="button"
          className="chaos-btn"
          onClick={crashWorker}
          disabled={busy !== null}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
          Delete worker pod
        </button>
        <span className="invariant">
          the invariant: <b>gaps stay 0</b>
        </span>
      </div>

      <div className="log-box" ref={logBox}>
        {log.map((l, i) => (
          <div key={i} className={`log ${l.cls ?? ""}`}>
            <span className="ts">{l.t}</span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
