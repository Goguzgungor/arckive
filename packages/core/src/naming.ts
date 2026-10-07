export class NamingError extends Error {}

export function toSnakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function assertPgIdentifier(id: string): string {
  if (Buffer.byteLength(id, 'utf8') > 63) {
    throw new NamingError(`PostgreSQL identifier exceeds 63 bytes: ${id}`);
  }
  return id;
}

export function schemaName(indexerName: string): string {
  return assertPgIdentifier(`idx_${toSnakeCase(indexerName)}`);
}

export function eventTableName(
  contractName: string,
  eventName: string,
  overloadTopic0?: string,
): string {
  const base = `${toSnakeCase(contractName)}_${toSnakeCase(eventName)}`;
  return assertPgIdentifier(overloadTopic0 ? `${base}_${overloadTopic0.slice(2, 6)}` : base);
}
