// Contracts verified on Arc's explorer (explorer.arc.io, Blockscout) when this
// map was written — an unverified address is never named. The zero address is
// no contract: it is the other party of every mint and burn.
export const POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

export const NAMES: Readonly<Record<string, string>> = {
  '0x0000000000000000000000000000000000000000': 'Mint / burn',
  [POOLMANAGER]: 'Uniswap v4 Pools',
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1': 'Uniswap Router',
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
};

export function nameOf(address: string): string | undefined {
  return NAMES[address.toLowerCase()];
}
