import { describe, expect, it } from 'vitest';
import { NATIVE_USDC, knownToken } from '../src/index.js';

describe('knownToken', () => {
  it('names native USDC on Arc mainnet and testnet, in 18 decimals', () => {
    expect(knownToken(5042, NATIVE_USDC)).toEqual({ label: 'USDC', decimals: 18 });
    expect(knownToken(5042002, NATIVE_USDC.toUpperCase().replace('0X', '0x'))).toEqual({ label: 'USDC', decimals: 18 });
  });

  it('knows nothing about other chains or addresses', () => {
    expect(knownToken(1, NATIVE_USDC)).toBeUndefined();
    expect(knownToken(5042, `0x${'36'}${'00'.repeat(19)}`)).toBeUndefined();
  });
});
