// How each lane is shown. Keys are the lanes the worker writes: core's LANES
// (the model's choice set) and the ruled ones. Kept free of @arckive/core so
// client components can import it; test/lanes.test.ts holds it to core's order.
export interface LaneMeta {
  label: string;
  ink: string;
  plural: string;
}

// Inks are CSS custom properties (app/globals.css) so each theme sets its own:
// the light values are the spec's, the dark ones the same hues lifted for a
// dark page.
const FAINT = 'var(--faint)';

export const LANE_META: Readonly<Record<string, LaneMeta>> = {
  swap: { label: 'Swap', ink: 'var(--l-swap)', plural: 'swaps' },
  bridge: { label: 'Bridge', ink: 'var(--l-bridge)', plural: 'bridge transfers' },
  liquidity: { label: 'Liquidity', ink: 'var(--l-liquidity)', plural: 'liquidity changes' },
  vault: { label: 'Vault', ink: 'var(--l-vault)', plural: 'vault moves' },
  lending: { label: 'Lending', ink: 'var(--l-lending)', plural: 'lending moves' },
  signed_payment: { label: 'Signed payment', ink: 'var(--l-signed_payment)', plural: 'signed payments' },
  payment: { label: 'Payment', ink: 'var(--l-payment)', plural: 'payments' },
  spam: { label: 'Dust', ink: FAINT, plural: 'dust' },
  issuance: { label: 'Mint / burn', ink: 'var(--l-issuance)', plural: 'mints and burns' },
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
