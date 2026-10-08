import { ZERO_ADDRESS, fmtAmount, fmtFee, fmtInt, fmtTime, shortAddr, shortHash, unitsToDecimal } from './format.js';
import type { Part } from './parts.js';
import type { TokenMeta } from './tokens.js';
import { usdcFace } from './usdc.js';
import type { PoolInfo, TxData, TxSwap, TxTransfer } from './tx.js';

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const usdc = (raw: string | bigint, decimals = 18): string => `${fmtAmount(unitsToDecimal(raw, decimals))} USDC`;
const plural = (n: number, one: string, many: string): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

export function isChain(ts: TxTransfer[]): boolean {
  return ts.every((t, i) => i === 0 || ts[i - 1]!.to === t.from);
}

function andList(addresses: string[]): Part[] {
  const out: Part[] = [];
  addresses.forEach((a, i) => {
    if (i > 0) out.push(i === addresses.length - 1 ? ' and ' : ', ');
    out.push({ addr: a });
  });
  return out;
}

// The USDC side of a swap, as the swapper's delta and that currency's
// decimals (native 18, the ERC-20 face 6); null when neither currency is USDC.
function usdcDelta(s: TxSwap, pool: PoolInfo | undefined): { delta: bigint; decimals: number } | null {
  if (!pool) return null;
  const f0 = usdcFace(pool.currency0);
  if (f0) return { delta: BigInt(s.amount0), decimals: f0.decimals };
  const f1 = usdcFace(pool.currency1);
  if (f1) return { delta: BigInt(s.amount1), decimals: f1.decimals };
  return null;
}

export function txHeadline(tx: TxData): Part[] {
  const T = tx.transfers;
  const s = tx.swaps[0];
  if (s) {
    const u = usdcDelta(s, tx.pools[s.pool]);
    if (u !== null && u.delta < 0n) return [{ addr: T[0]?.from ?? s.sender }, ' swapped ', { b: usdc(abs(u.delta), u.decimals) }, ' on Uniswap v4.'];
    if (u !== null && u.delta > 0n) return [{ addr: T.at(-1)?.to ?? s.sender }, ' swapped for ', { b: usdc(u.delta, u.decimals) }, ' on Uniswap v4.'];
    return ['A swap on Uniswap v4.'];
  }
  if (!T.length) {
    if (tx.inits.length) return ['A Uniswap v4 pool was created.'];
    if (tx.modifies.length) return ['Liquidity changed in a Uniswap v4 pool.'];
    return ['A donation to a Uniswap v4 pool.'];
  }
  const first = T[0]!;
  const last = T.at(-1)!;
  if (isChain(T)) {
    if (first.from === ZERO_ADDRESS) return [{ b: usdc(last.value) }, ' were minted to ', { addr: last.to }, '.'];
    if (last.to === ZERO_ADDRESS) return [{ b: usdc(first.value) }, ' were burned from ', { addr: first.from }, '.'];
    if (T.length === 1 && first.from === first.to) return [{ addr: first.from }, ' sent ', { b: usdc(first.value) }, ' to itself.'];
    return [{ addr: first.from }, ' paid ', { addr: last.to }, ' ', { b: usdc(first.value) }, '.'];
  }
  const total = T.reduce((n, t) => n + BigInt(t.value), 0n);
  return [{ b: fmtInt(T.length) }, ' USDC movements in this transaction, ', { b: usdc(total) }, ' in all.'];
}

export interface SwapSide {
  amount: string; // with unknown decimals: the raw integer, grouped
  token: string;
  tokenAddress: string;
  decimals: boolean; // whether the amount is scaled by the token's decimals
  note: string; // the line under the amount: the token, and what is not known about it
}

export interface SwapView {
  li: number;
  pool: string;
  paid: SwapSide | null;
  received: SwapSide | null;
  fee: string;
  known: boolean;
}

// A token that does not answer decimals() shows its raw integer: scaling it
// by a guess would print a wrong amount with confidence.
function side(address: string, delta: bigint, meta: TokenMeta | undefined): SwapSide {
  const face = usdcFace(address);
  const decimals = face ? face.decimals : (meta?.decimals ?? null);
  const amount = decimals === null ? fmtInt(abs(delta)) : fmtAmount(unitsToDecimal(abs(delta), decimals));
  const symbol = face ? face.label : (meta?.symbol ?? null);
  const token = symbol ?? shortAddr(address);
  const note = [symbol ?? `token ${token}`, ...(decimals === null ? ['decimals unknown'] : [])].join(' · ');
  return { amount, token, tokenAddress: address, decimals: decimals !== null, note };
}

// Uniswap v4 logs Swap amounts as the swapper's balance deltas: negative was
// paid into the pool, positive came out of it. Checked on mainnet tx
// 0x9a83…015a: amount0 −476.9325 native USDC paid, amount1 +13.76M received.
export function swapView(s: TxSwap, pool: PoolInfo | undefined, tokens: Record<string, TokenMeta>): SwapView {
  if (!pool) return { li: s.li, pool: s.pool, paid: null, received: null, fee: fmtFee(s.fee), known: false };
  const sides = [[pool.currency0, BigInt(s.amount0)], [pool.currency1, BigInt(s.amount1)]] as const;
  const paid = sides.find(([, d]) => d < 0n);
  const received = sides.find(([, d]) => d > 0n);
  return {
    li: s.li,
    pool: s.pool,
    paid: paid ? side(paid[0], paid[1], tokens[paid[0]]) : null,
    received: received ? side(received[0], received[1], tokens[received[0]]) : null,
    fee: fmtFee(s.fee),
    known: true,
  };
}

export function txPath(tx: TxData, tokens: Record<string, TokenMeta>): Part[] {
  const T = tx.transfers;
  const at = ` at ${fmtTime(tx.time)} UTC.`;
  const out: Part[] = [];
  if (T.length >= 2 && isChain(T)) {
    const via = andList(T.slice(1).map((t) => t.from));
    out.push('The USDC went from ', { addr: T[0]!.from }, ' through ', ...via, ' to ', { addr: T.at(-1)!.to }, ' in block ', { b: fmtInt(tx.block) }, at);
  } else {
    out.push('In block ', { b: fmtInt(tx.block) }, at);
  }
  const s = tx.swaps[0];
  if (s) {
    const v = swapView(s, tx.pools[s.pool], tokens);
    const of = (x: SwapSide): string => `${x.decimals ? '' : ' (raw units)'} of ${x.token}.`;
    // the other side of the swap, not the USDC one
    if (v.received && !usdcFace(v.received.tokenAddress)) out.push(' It came back as ', { b: v.received.amount }, of(v.received));
    else if (v.paid && !usdcFace(v.paid.tokenAddress)) out.push(' It was paid for with ', { b: v.paid.amount }, of(v.paid));
  }
  return out;
}

// Under "How the money moved": the figure's caption, or, when the movements
// form no chain to draw, a pointer to the list that does show them.
export function flowCaption(drawn: boolean): string {
  const scope = 'Arckive indexes USDC and Uniswap v4 events only; gas and other tokens are not shown.';
  return drawn
    ? `Fig. 1 — every USDC movement in this transaction, in log order. ${scope}`
    : `Fig. 1 — the USDC movements are listed under Events, in log order; they do not form one chain to draw. ${scope}`;
}

export interface FlowView {
  nodes: { role: string; address: string }[];
  edges: { amount: string; li: number }[];
}

// "How the money moved" as nodes and arrows, when the transfers form one chain of at most six.
export function flowView(ts: TxTransfer[]): FlowView | null {
  if (!ts.length || ts.length > 6 || !isChain(ts)) return null;
  const addresses = [ts[0]!.from, ...ts.map((t) => t.to)];
  return {
    nodes: addresses.map((address, i) => ({ role: i === 0 ? 'Payer' : i === addresses.length - 1 ? 'Arrived at' : 'Through', address })),
    edges: ts.map((t) => ({ amount: fmtAmount(unitsToDecimal(t.value)), li: t.li })),
  };
}

export interface EventRow {
  li: number;
  kind: 'Transfer' | 'Swap' | 'Liquidity' | 'Donate' | 'Initialize';
  parts: Part[];
  amount: string | null;
}

export function eventRows(tx: TxData): EventRow[] {
  const rows: EventRow[] = [
    ...tx.transfers.map((t): EventRow => ({ li: t.li, kind: 'Transfer', parts: [{ addr: t.from }, ' → ', { addr: t.to }], amount: usdc(t.value) })),
    ...tx.swaps.map((s): EventRow => ({ li: s.li, kind: 'Swap', parts: ['pool ', shortHash(s.pool), ' · sender ', { addr: s.sender }], amount: null })),
    ...tx.modifies.map((m): EventRow => ({
      li: m.li, kind: 'Liquidity', parts: ['pool ', shortHash(m.pool), BigInt(m.liquidityDelta) < 0n ? ' · removed by ' : ' · added by ', { addr: m.sender }], amount: null,
    })),
    ...tx.donates.map((d): EventRow => ({ li: d.li, kind: 'Donate', parts: ['pool ', shortHash(d.pool), ' · from ', { addr: d.sender }], amount: null })),
    ...tx.inits.map((i): EventRow => ({ li: i.li, kind: 'Initialize', parts: ['pool ', shortHash(i.pool), ' created · fee ', fmtFee(i.fee)], amount: null })),
  ];
  return rows.sort((a, b) => a.li - b.li);
}

export function txFacts(tx: TxData): { protocol: string; pool: string | null; parties: string[] } {
  const poolEvents = [...tx.swaps, ...tx.modifies, ...tx.donates, ...tx.inits];
  const parties = [...new Set(tx.transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a !== ZERO_ADDRESS).slice(0, 8);
  return { protocol: poolEvents.length ? 'Uniswap v4' : 'USDC', pool: poolEvents[0]?.pool ?? null, parties };
}

export function legsLabel(tx: TxData): string {
  const parts = [plural(tx.transfers.length, 'USDC movement', 'USDC movements')];
  if (tx.swaps.length) parts.push(plural(tx.swaps.length, 'swap', 'swaps'));
  return parts.join(' · ');
}

// The pool currencies a page needs symbols for (address(0) is answered without a call).
export function tokenAddresses(tx: TxData): string[] {
  return [...new Set(Object.values(tx.pools).flatMap((p) => [p.currency0, p.currency1]))];
}
