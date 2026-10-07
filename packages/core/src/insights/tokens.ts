import type { TokenInfo } from './sentence.js';

// Token facts the chain cannot answer. Arc logs every native USDC movement —
// including the twin of every ERC-20 USDC transfer — as a Transfer from
// 0xff…fe, an address with no code: no symbol(), no decimals(). Its values are
// in USDC's native 18 decimals.
export const NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe';

const ARC: ReadonlyMap<string, TokenInfo> = new Map([[NATIVE_USDC, { label: 'USDC', decimals: 18 }]]);

const KNOWN_TOKENS: ReadonlyMap<number, ReadonlyMap<string, TokenInfo>> = new Map([
  [5042, ARC], // Arc mainnet
  [5042002, ARC], // Arc testnet
]);

export function knownToken(chainId: number, address: string): TokenInfo | undefined {
  return KNOWN_TOKENS.get(chainId)?.get(address.toLowerCase());
}
