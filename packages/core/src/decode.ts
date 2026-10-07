import { decodeEventLog } from 'viem';
import type { EventDef } from './abi.js';
import { eventColumns } from './ddl.js';

export class DecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface RawLog {
  address: `0x${string}`;
  topics: [`0x${string}`, ...`0x${string}`[]] | [];
  data: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  transactionIndex: number;
  logIndex: number;
}

export interface DecodedRow {
  tableName: string;
  // written once per block to _blocks, not into the event table
  blockHash: `0x${string}`;
  // also per block: written to _blocks with the hash
  blockTime: Date;
  // an address param is a 20-byte Buffer under its _id column; the worker swaps it for an id
  columns: Record<string, unknown>;
}

const hexBytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');

export function toSqlValue(abiType: string, value: unknown): unknown {
  if (abiType.endsWith(']') || abiType.startsWith('tuple')) {
    return JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  }
  if (abiType === 'address') return hexBytes(String(value));
  if (/^bytes(\d+)?$/.test(abiType)) return hexBytes(String(value));
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function decodeLogToRow(def: EventDef, log: RawLog, blockTime: Date): DecodedRow {
  let args: unknown;
  try {
    ({ args } = decodeEventLog({ abi: [def.event], data: log.data, topics: log.topics }));
  } catch (cause) {
    throw new DecodeError(`${def.tableName}: failed to decode log`, { cause });
  }
  const columns: Record<string, unknown> = {
    block_number: log.blockNumber.toString(),
    tx_hash: hexBytes(log.transactionHash),
    log_index: log.logIndex,
  };
  const cols = eventColumns(def.event);
  for (const [i, col] of cols.entries()) {
    const param = def.event.inputs[i]!;
    const raw = param.name
      ? (args as Record<string, unknown>)[param.name]
      : (args as unknown[])[i];
    if (raw === undefined) {
      throw new DecodeError(`${def.tableName}: parameter '${col.name}' missing from decode result`);
    }
    columns[col.name] = toSqlValue(col.abiType, raw);
  }
  return { tableName: def.tableName, blockHash: log.blockHash, blockTime, columns };
}
