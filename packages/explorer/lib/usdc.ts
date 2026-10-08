import { ZERO_ADDRESS } from './format.js';

// USDC has two faces on Arc, and a v4 pool may pair either: the chain's
// native currency (address(0) in a pool key, 18 decimals) and its ERC-20
// interface at 0x3600…0000 (6 decimals). Client-safe: no database, no RPC.
export const NATIVE_USDC_CURRENCY = ZERO_ADDRESS;
export const ERC20_USDC = '0x3600000000000000000000000000000000000000';

export interface UsdcFace {
  symbol: 'USDC';
  decimals: number;
  label: string; // how a swap's token line names it
}

const FACES: Readonly<Record<string, UsdcFace>> = {
  [NATIVE_USDC_CURRENCY]: { symbol: 'USDC', decimals: 18, label: 'USDC (native)' },
  [ERC20_USDC]: { symbol: 'USDC', decimals: 6, label: 'USDC' },
};

// null: not USDC
export function usdcFace(currency: string): UsdcFace | null {
  return FACES[currency.toLowerCase()] ?? null;
}
