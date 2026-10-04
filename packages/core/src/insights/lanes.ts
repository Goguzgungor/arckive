// The question the model answers about every unruled event, ported verbatim
// from radar/radar/classify.py. Measured there on ten minutes of Arc mainnet
// (16,632 transfers) against an audited fact table: 99.9% agreement.
//
// The order is part of the question: moving spam first cost 14 points. Spam is
// offered but never decided by the model — removing the option cost accuracy
// elsewhere, so it stays last, as a sink. Mint and burn are not offered: as an
// option it drew probability from every lane; the transfer decides it. Laya
// clamps its temperature at 11 or more options, so the set stays at ten or
// fewer.
export const LANES: Readonly<Record<string, string>> = {
  swap: 'tokens were swapped on an exchange or traded on a marketplace',
  bridge: 'funds were sent to or arrived from another chain through a bridge, even if tokens were also swapped',
  liquidity: 'pool liquidity changed, even if tokens were also swapped',
  vault: 'funds were deposited into or withdrawn from a vault, or USDC was wrapped or unwrapped',
  lending: 'a loan was opened, repaid or liquidated',
  signed_payment: 'the payer signed an authorization and someone else submitted it',
  payment: 'a plain direct transfer, with nothing else happening',
  spam: 'zero or less than one cent of USDC moved and nothing else recognisable happened',
};

export const LANE_QUESTION = {
  type: 'choice',
  instructions: 'What kind of Arc transaction is this?',
  criteria: LANES,
} as const;

// Below this the lane is uncertain rather than guessed (radar/radar/server.py).
export const UNCERTAIN_BELOW = 0.35;

export interface LaneAnswer {
  choice: string;
  probabilities: Record<string, number>;
}

export interface SettledLane {
  lane: string;
  laneP: number | null; // null when ruled or unanswered
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// Radar's settle_lane. A ruled lane stands, with no confidence. The model's
// choice stands unless it is spam — the transfer's call, not the model's — in
// which case its runner-up does; anything outside the set, or too weak to
// stand on, is uncertain.
export function settleLane(answer: LaneAnswer | null, ruled: string): SettledLane {
  if (ruled) return { lane: ruled, laneP: null };
  if (!answer) return { lane: 'uncertain', laneP: null };
  const probabilities = Object.entries(answer.probabilities);
  let lane = answer.choice;
  let p = probabilities.length ? Math.max(...probabilities.map(([, v]) => v)) : 0;
  if (lane === 'spam') {
    const rest = probabilities.filter(([k]) => Object.hasOwn(LANES, k) && k !== 'spam');
    if (!rest.length) return { lane: 'uncertain', laneP: 0 };
    [lane, p] = rest.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  }
  p = round3(p);
  if (!Object.hasOwn(LANES, lane) || p < UNCERTAIN_BELOW) return { lane: 'uncertain', laneP: p };
  return { lane, laneP: p };
}
