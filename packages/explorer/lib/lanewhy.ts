import { LANES, UNCERTAIN_BELOW } from '@arckive/core';

// What a ruled lane was ruled by (core's insights rules), in the page's words.
const RULED: Readonly<Record<string, string>> = {
  issuance: 'Ruled: USDC was minted or burned — the zero address is a party.',
  // core: a transfer of value 0 with only incidental facts beside it
  spam: 'Ruled: no USDC moved and nothing else recognisable happened.',
  uncertain: 'Ruled: the transfer gave too little to read.',
  no_transfer: 'Ruled: nothing was transferred in this transaction.',
};

export function laneWhy(lane: string, ruled: boolean): string {
  if (ruled) return RULED[lane] ?? 'Ruled by the transaction itself.';
  if (lane === 'uncertain') return `Laya was not sure enough to file it (below ${UNCERTAIN_BELOW}).`;
  const text = LANES[lane];
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : 'Laya filed it under this lane.';
}
