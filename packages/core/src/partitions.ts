import { assertPgIdentifier } from './naming.js';

const q = (id: string) => `"${id}"`;

// Layout 2 range-partitions every row table by block_number in fixed spans:
// partition n holds [n·size, (n+1)·size). Fixed spans need no catalogue of
// boundaries — a block's partition is arithmetic — and a name that would be
// truncated past 63 bytes would make two partitions collide, so it throws.
export function partitionOf(block: bigint, size: bigint): bigint {
  return block / size;
}

export function partitionName(table: string, n: bigint): string {
  return assertPgIdentifier(`${table}_p${n}`);
}

export function partitionDdl(schema: string, table: string, n: bigint, size: bigint): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(partitionName(table, n))} PARTITION OF ${q(schema)}.${q(table)} ` +
    `FOR VALUES FROM (${n * size}) TO (${(n + 1n) * size})`
  );
}
