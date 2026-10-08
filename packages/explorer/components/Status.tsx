import { lagText, type LiveState } from '../lib/live.js';

// null: a page that cannot know (a static 404) says only where it is.
export function Status({ state }: { state: LiveState | null }) {
  if (!state) return <span className="status">Arc mainnet</span>;
  const text =
    state.kind === 'live' ? 'Arc mainnet, live' : state.kind === 'behind' ? `Arc mainnet, ${lagText(state.seconds)}` : 'Arc mainnet, reconnecting';
  return (
    <span className={`status ${state.kind}`} role="status">
      <b aria-hidden="true">●</b> {text}
    </span>
  );
}
