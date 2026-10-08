// Fixture rows for the explorer's tests and the browser smoke. Around one
// real Arc mainnet swap (the mockups' transaction) the rows cover a payment,
// a payment chain, a mint, a burn, a self-transfer, pool events and an
// address with more than one page of history across a UTC day boundary.

export const SCHEMA = 'idx_arc_explorer';
// small partitions, so keyset paging crosses partitions as in production
export const PARTITION_BLOCKS = 100n;
export const ZERO = '0x0000000000000000000000000000000000000000';
export const NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe';
export const POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';

const E18 = 10n ** 18n;
export const usdc = (whole: number, cents = 0): string => (BigInt(whole) * E18 + BigInt(cents) * 10n ** 16n).toString();
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const a = (tag: string): string => `0x${tag.repeat(40 / tag.length)}`;

// Mainnet tx 0x9a83…015a, block 24,787,775: 476.9325 USDC from the payer
// through 0x43d8…41d5 and the router into the PoolManager, which logs Swap at
// log 3 with amount0 −476.9325 (currency0 = address(0): native USDC, paid into
// the pool) and amount1 +13,763,833.33… of 0x6e71…b777.
export const SWAP_TX = '0x9a833894c76d093d304e8e907ae79a37ddaac7753fa9855df456643eba0f015a';
export const SWAP_POOL = '0x6c96ee62f2fcebe56264711c18d20e89bed338d4f055628313c9086f3add79e8';
export const SWAP_PAYER = '0x5e2928212630ccd57bc53f0df428fb678c0da2b7';
export const SWAP_HOP = '0x43d894e229a008c72e96872739719b9cfda941d5';
export const SWAP_TOKEN = '0x6e7155b7962844f2a0957d017416486f9efeb777';
export const SWAP_PAID = '476932500000000000000';
export const SWAP_RECEIVED = '13763833330793760056038261';
export const INIT_TX = '0x2cf901c8a420b3c34789a5f9e75e14d8f4a66051e83c24ad8749759bf4c79135';

export const PAY_TX = h(0x1001);
export const PAYER = a('88a5');
export const PAYEE = a('1c40');
export const CHAIN_TX = h(0x1002);
export const CHAIN = [a('c1'), a('c2'), a('c3'), a('c4')];
export const MINT_TX = h(0x1003);
export const BURN_TX = h(0x1004);
export const MINTEE = a('d00d');
export const SELF_TX = h(0x1005);
export const SELF = a('5e1f');
export const POOL_TX = h(0x1006);
export const LP = a('1b');
export const BUSY = a('b5');
export const CPS = [a('e1'), a('e2'), a('e3')];
export const UNSEEN = a('0f');

export interface Block { n: number; time: string }
export interface Transfer { n: number; li: number; tx: string; from: string; to: string; value: string }
export interface Swap { n: number; li: number; tx: string; pool: string; sender: string; amount0: string; amount1: string; fee: number }
export interface Init { n: number; li: number; tx: string; pool: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
export interface Modify { n: number; li: number; tx: string; pool: string; sender: string; tickLower: number; tickUpper: number; liquidityDelta: string }
export interface Donate { n: number; li: number; tx: string; pool: string; sender: string; amount0: string; amount1: string }
export interface Lane { n: number; li: number; lane: string; p: number | null; ruled: boolean; sentence: string }

// The busy address: 30 blocks, 40 apart (so 12 partitions), the first ten on
// 2026-10-07 and the rest on 2026-10-08 (UTC). Even i: in from CPS[i % 3];
// odd i: out to CPS[i % 3]; i = 15 a self-transfer; block i = 29 has a second
// row at log 1 (in).
export const BUSY_BASE = 24860000;
export const busyBlock = (i: number): number => BUSY_BASE + i * 40;
const busyTime = (i: number): string => new Date(Date.UTC(2026, 9, 7, 23, 59, 40) + i * 2000).toISOString();

export const BLOCKS: Block[] = [
  { n: 24787025, time: '2026-10-07T20:27:11Z' },
  { n: 24787775, time: '2026-10-07T20:33:32Z' },
  { n: 24787800, time: '2026-10-07T20:33:45Z' },
  { n: 24787801, time: '2026-10-07T20:33:45Z' },
  { n: 24787802, time: '2026-10-07T20:33:46Z' },
  { n: 24787803, time: '2026-10-07T20:33:46Z' },
  { n: 24787804, time: '2026-10-07T20:33:47Z' },
  { n: 24787850, time: '2026-10-07T20:34:10Z' },
  ...Array.from({ length: 30 }, (_, i) => ({ n: busyBlock(i), time: busyTime(i) })),
];

const busyRows: Transfer[] = Array.from({ length: 30 }, (_, i): Transfer => {
  const tx = h(0x2000 + i);
  if (i === 15) return { n: busyBlock(i), li: 0, tx, from: BUSY, to: BUSY, value: usdc(16) };
  const cp = CPS[i % 3]!;
  return i % 2 === 0
    ? { n: busyBlock(i), li: 0, tx, from: cp, to: BUSY, value: usdc(1 + i, 25) }
    : { n: busyBlock(i), li: 0, tx, from: BUSY, to: cp, value: usdc(1 + i) };
});
busyRows.push({ n: busyBlock(29), li: 1, tx: h(0x2100), from: CPS[0]!, to: BUSY, value: usdc(0, 1) });
export const BUSY_ROWS: readonly Transfer[] = busyRows;

export const TRANSFERS: Transfer[] = [
  { n: 24787775, li: 1, tx: SWAP_TX, from: SWAP_PAYER, to: SWAP_HOP, value: SWAP_PAID },
  { n: 24787775, li: 2, tx: SWAP_TX, from: SWAP_HOP, to: ROUTER, value: SWAP_PAID },
  { n: 24787775, li: 4, tx: SWAP_TX, from: ROUTER, to: POOLMANAGER, value: SWAP_PAID },
  { n: 24787800, li: 0, tx: PAY_TX, from: PAYER, to: PAYEE, value: usdc(311, 55) },
  { n: 24787801, li: 0, tx: CHAIN_TX, from: CHAIN[0]!, to: CHAIN[1]!, value: usdc(50) },
  { n: 24787801, li: 1, tx: CHAIN_TX, from: CHAIN[1]!, to: CHAIN[2]!, value: usdc(50) },
  { n: 24787801, li: 2, tx: CHAIN_TX, from: CHAIN[2]!, to: CHAIN[3]!, value: usdc(50) },
  { n: 24787802, li: 0, tx: MINT_TX, from: ZERO, to: MINTEE, value: usdc(10000) },
  { n: 24787803, li: 0, tx: BURN_TX, from: MINTEE, to: ZERO, value: usdc(5) },
  { n: 24787804, li: 0, tx: SELF_TX, from: SELF, to: SELF, value: usdc(1) },
  ...BUSY_ROWS,
];

export const INITS: Init[] = [
  { n: 24787025, li: 3, tx: INIT_TX, pool: SWAP_POOL, currency0: ZERO, currency1: SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: ZERO },
];

export const SWAPS: Swap[] = [
  { n: 24787775, li: 3, tx: SWAP_TX, pool: SWAP_POOL, sender: ROUTER, amount0: `-${SWAP_PAID}`, amount1: SWAP_RECEIVED, fee: 2500 },
];

export const MODIFIES: Modify[] = [
  { n: 24787850, li: 0, tx: POOL_TX, pool: SWAP_POOL, sender: LP, tickLower: -600, tickUpper: 600, liquidityDelta: '1000000000000' },
];

export const DONATES: Donate[] = [
  { n: 24787850, li: 1, tx: POOL_TX, pool: SWAP_POOL, sender: LP, amount0: usdc(1), amount1: '0' },
];

const SWAP_SENTENCE = 'USDC moved from a wallet to a contract, amount 100 to 1,000 USDC. In the same transaction: tokens were swapped on an exchange.';

// Lanes up to INSIGHTS_CURSOR: the swap (model), the payment (model), the
// mint (ruled), busy rows i < 20 alternating payment / signed payment. The
// chain, burn, self-transfer and pool rows sit inside the read range with no
// lane; busy rows i >= 20 sit above the cursor (not read yet); the Initialize
// is older than the first lane.
export const LANES: Lane[] = [
  ...[1, 2, 3, 4].map((li): Lane => ({ n: 24787775, li, lane: 'swap', p: 0.91, ruled: false, sentence: SWAP_SENTENCE })),
  { n: 24787800, li: 0, lane: 'payment', p: 0.88, ruled: false, sentence: 'USDC moved from a wallet to a wallet, amount 100 to 1,000 USDC.' },
  { n: 24787802, li: 0, lane: 'issuance', p: null, ruled: true, sentence: 'USDC was minted, amount over 1,000 USDC.' },
  ...BUSY_ROWS.filter((r) => r.n < busyBlock(20)).map((r, i): Lane => ({
    n: r.n, li: r.li, lane: i % 2 ? 'signed_payment' : 'payment', p: 0.8, ruled: false, sentence: `busy movement ${i}`,
  })),
];

export const CURSOR = busyBlock(29);
export const INSIGHTS_CURSOR = busyBlock(19);
export const FIRST_LANE_BLOCK = 24787775;
