import { HomeLive } from '../components/HomeLive.js';
import { fmtDateLong } from '../lib/format.js';
import { getRuntime } from '../lib/runtime.js';
import type { Hello } from '../lib/types.js';

export const dynamic = 'force-dynamic';

// Rendered with the tailer's latest movements so the first paint already
// shows the tape; the stream takes over in the browser.
export default function Home() {
  let initial: Hello = { blocks: [], stats: null };
  try {
    initial = getRuntime().hub.hello();
  } catch {
    // no runtime yet: the stream fills the tape on its own
  }
  return <HomeLive initial={initial} date={fmtDateLong(new Date())} />;
}
