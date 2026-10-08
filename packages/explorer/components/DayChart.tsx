import { barTitle, chartBars } from '../lib/addrstory.js';
import type { DayBar } from '../lib/address.js';

const W = 840;
const H = 190;
const MID = 100;
const HALF = 82;

// USDC in above the line, out below, one bar per UTC day over the whole history.
export function DayChart({ days }: { days: DayBar[] }) {
  const { bars, barWidth } = chartBars(days, W, HALF);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="USDC received and sent per day">
      <line x1="0" x2={W} y1={MID} y2={MID} stroke="#15171b" strokeWidth="1" />
      {bars.map((b) => (
        <g key={b.day}>
          <title>{barTitle(b)}</title>
          {b.inH > 0 && <rect x={b.x} y={MID - b.inH} width={barWidth} height={b.inH} fill="#1d8a57" />}
          {b.outH > 0 && <rect x={b.x} y={MID + 1} width={barWidth} height={b.outH} fill="#b2412f" opacity=".85" />}
        </g>
      ))}
      <text x="0" y="12">in</text>
      <text x="0" y={H - 4}>out</text>
    </svg>
  );
}
