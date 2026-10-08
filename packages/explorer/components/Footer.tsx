import { fmtBytes, fmtInt } from '../lib/format.js';
import { getRuntime } from '../lib/runtime.js';

// The database size is shown so a full disk is seen coming (100 GB holds
// about 140 days after launch).
export function Footer() {
  const facts: string[] = [];
  try {
    const rt = getRuntime();
    if (rt.head) facts.push(`block ${fmtInt(rt.head.block)}`);
    if (rt.dbBytes !== null) facts.push(`archive ${fmtBytes(rt.dbBytes)}`);
  } catch {
    // no runtime (the build, or before configuration): the footer stays plain
  }
  return (
    <footer>
      <span>Native USDC and the Uniswap v4 PoolManager on Arc mainnet, read from Arckive’s own archive.</span>
      <span>{facts.join(' · ') || 'Arc mainnet'}</span>
    </footer>
  );
}
