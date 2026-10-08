import { chartBars, dayReadout } from '../lib/addrstory.js';
import type { DayBar } from '../lib/address.js';
import { DayChartView } from './DayChartView.js';

const W = 840;
const H = 190;
const MID = 100;
const HALF = 82;

// USDC in above the line, out below, one bar per UTC day over the whole
// history. Bars and their readouts are worked out here, on the server; the
// view only draws them and follows the pointer.
export function DayChart({ days }: { days: DayBar[] }) {
  const { bars, barWidth, pitch } = chartBars(days, W, HALF);
  const view = bars.map((b) => ({ x: b.x, inH: b.inH, outH: b.outH, ...dayReadout(b) }));
  return <DayChartView days={view} barWidth={barWidth} pitch={pitch} width={W} height={H} mid={MID} />;
}
