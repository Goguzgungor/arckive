"use client";

import { fmt, useLiveIndexer } from "./LiveIndexer";

export default function IndexerStatus() {
  const { phase, current, head } = useLiveIndexer();
  const lag = head - current;
  const label =
    phase === "provisioning"
      ? "Provisioning"
      : phase === "backfilling"
        ? "Backfilling"
        : "Live";

  return (
    <div className="status-card" aria-live="off">
      <div className="status-head">
        <span className={`dot ${phase === "live" ? "on" : ""}`} />
        <b>
          {phase === "live"
            ? "Open now · usdc-arc is Live"
            : `usdc-arc · ${label}`}
        </b>
        <span className="mono status-cmd">kubectl get indexers -w</span>
      </div>
      <div className="scroll-x">
        <table className="hours">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phase</th>
              <th className="num">Current</th>
              <th className="num">Head</th>
              <th className="num">Lag</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>usdc-arc</b>
              </td>
              <td
                className={
                  phase === "live"
                    ? "ok"
                    : phase === "backfilling"
                      ? "warn"
                      : "blue"
                }
              >
                {label}
              </td>
              <td className="num">
                {phase === "provisioning" ? "—" : fmt(current)}
              </td>
              <td className="num">
                {phase === "provisioning" ? "—" : fmt(head)}
              </td>
              <td className={`num ${lag === 0 && phase === "live" ? "ok" : ""}`}>
                {phase === "provisioning" ? "—" : fmt(lag)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="status-note">
        Status is patched onto the resource itself. No dashboard to log into.
      </p>
    </div>
  );
}
