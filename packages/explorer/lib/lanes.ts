// How each lane is shown. Keys are the lanes the worker writes: core's LANES
// (the model's choice set) and the ruled ones. Kept free of @arckive/core so
// client components can import it; test/lanes.test.ts holds it to core's order.
export interface LaneMeta {
  label: string;
  ink: string;
  plural: string;
}

const FAINT = '#8b8f97';

export const LANE_META: Readonly<Record<string, LaneMeta>> = {
  swap: { label: 'Swap', ink: '#7442d1', plural: 'swaps' },
  bridge: { label: 'Bridge', ink: '#0b7fb0', plural: 'bridge transfers' },
  liquidity: { label: 'Liquidity', ink: '#1d8a57', plural: 'liquidity changes' },
  vault: { label: 'Vault', ink: '#8d55e8', plural: 'vault moves' },
  lending: { label: 'Lending', ink: '#a87800', plural: 'lending moves' },
  signed_payment: { label: 'Signed payment', ink: '#2a7fa8', plural: 'signed payments' },
  payment: { label: 'Payment', ink: '#3550c8', plural: 'payments' },
  spam: { label: 'Dust', ink: FAINT, plural: 'dust' },
  issuance: { label: 'Mint / burn', ink: '#c06a12', plural: 'mints and burns' },
  uncertain: { label: 'Uncertain', ink: FAINT, plural: 'uncertain movements' },
  no_transfer: { label: 'No transfer', ink: FAINT, plural: 'events without a transfer' },
};

// core's LANES order (the order is part of the measured question), then the ruled lanes
export const LANE_ORDER: readonly string[] = [
  'swap', 'bridge', 'liquidity', 'vault', 'lending', 'signed_payment', 'payment', 'spam',
  'issuance', 'uncertain', 'no_transfer',
];

// shown in "By lane" even at 0%; the others only when present
export const LANES_ALWAYS: readonly string[] = [
  'swap', 'bridge', 'liquidity', 'vault', 'lending', 'signed_payment', 'payment', 'spam', 'issuance',
];

export function laneMeta(lane: string | null): LaneMeta {
  if (lane === null) return { label: '—', ink: FAINT, plural: '' };
  return LANE_META[lane] ?? { label: lane.replace(/_/g, ' '), ink: FAINT, plural: lane.replace(/_/g, ' ') };
}
