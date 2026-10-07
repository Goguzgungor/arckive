import { describe, expect, it } from 'vitest';
import { NamingError, partitionDdl, partitionName, partitionOf } from '../src/index.js';

describe('partitions', () => {
  it('maps a block to its partition', () => {
    expect(partitionOf(0n, 1000n)).toBe(0n);
    expect(partitionOf(999n, 1000n)).toBe(0n);
    expect(partitionOf(1000n, 1000n)).toBe(1n);
    expect(partitionOf(24_747_528n, 2_000_000n)).toBe(12n);
  });

  it('names and creates a partition over [n·P, (n+1)·P)', () => {
    expect(partitionName('usdc_transfer', 12n)).toBe('usdc_transfer_p12');
    expect(partitionDdl('idx_x', 'usdc_transfer', 12n, 2_000_000n)).toBe(
      'CREATE TABLE IF NOT EXISTS "idx_x"."usdc_transfer_p12" PARTITION OF "idx_x"."usdc_transfer" ' +
        'FOR VALUES FROM (24000000) TO (26000000)',
    );
  });

  it('refuses a partition name over 63 bytes', () => {
    expect(() => partitionName('t'.repeat(60), 1234n)).toThrow(NamingError);
  });
});
