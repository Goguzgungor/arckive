"use client";

import { fmt, useLiveIndexer } from "./LiveIndexer";

const TINTS = ["peach", "salmon", "beige", "blue"];

export default function LatestEvents() {
  const { phase, rows } = useLiveIndexer();

  if (phase !== "live" || rows.length === 0) {
    return (
      <p className="events-empty">
        {phase === "provisioning"
          ? "Provisioning — the first row lands once the worker is up."
          : "Backfilling — rows stream in as soon as the cursor reaches head."}
      </p>
    );
  }

  return (
    <div className="events">
      {rows.map((r, i) => (
        <div key={r.bn} className={`event${i === 0 ? " fresh" : ""}`}>
          <div className={`badge ${TINTS[i % TINTS.length]}`}>
            <small>block</small>
            <b>{fmt(r.bn)}</b>
          </div>
          <div>
            <h3>Transfer · {r.value} USDC</h3>
            <div className="meta">
              <span className="mono">
                {r.from} → {r.to}
              </span>
              <br />
              usdc_transfer · {r.ms} ms after close
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
