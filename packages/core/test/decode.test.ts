import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { describe, expect, it } from 'vitest';
import { extractEventDefs } from '../src/abi.js';
import { DecodeError, decodeLogToRow, toSqlValue, type RawLog } from '../src/decode.js';

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const TRANSFER_ABI = [
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

const FROM = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;

function makeLog(): RawLog {
  return {
    address: ADDR,
    topics: encodeEventTopics({
      abi: TRANSFER_ABI, eventName: 'Transfer', args: { from: FROM, to: TO },
    }) as RawLog['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }], [123456789n]),
    blockNumber: 42n,
    blockHash: '0xabc0000000000000000000000000000000000000000000000000000000000000',
    transactionHash: '0xdef0000000000000000000000000000000000000000000000000000000000000',
    transactionIndex: 3,
    logIndex: 7,
  };
}

describe('toSqlValue', () => {
  it('bigint → string, address → 20-byte Buffer, bytes → Buffer, array → JSON string', () => {
    expect(toSqlValue('uint256', 5n)).toBe('5');
    expect(toSqlValue('address', '0xAbCd' + '00'.repeat(18))).toEqual(Buffer.from('abcd' + '00'.repeat(18), 'hex'));
    expect((toSqlValue('address', `0x${'11'.repeat(20)}`) as Buffer).length).toBe(20);
    expect(toSqlValue('bytes32', `0x${'ff'.repeat(32)}`)).toEqual(Buffer.from('ff'.repeat(32), 'hex'));
    expect(toSqlValue('uint256[]', [1n, 2n])).toBe('["1","2"]');
  });
});

describe('decodeLogToRow', () => {
  it('fills layout-2 columns; the block hash rides beside them', () => {
    const def = extractEventDefs('usdc', ADDR, TRANSFER_ABI as unknown as unknown[])[0]!;
    const log = makeLog();
    const row = decodeLogToRow(def, log, new Date(1000));
    expect(row.tableName).toBe('usdc_transfer');
    expect(row.blockHash).toBe(log.blockHash);
    expect(Object.keys(row.columns)).toEqual([
      'block_number', 'block_time', 'tx_hash', 'tx_index', 'log_index', 'from', 'to', 'value',
    ]);
    expect(row.columns['tx_hash']).toEqual(Buffer.from(log.transactionHash.slice(2), 'hex'));
    expect(row.columns['block_number']).toBe(log.blockNumber.toString());
    expect(row.columns['from']).toEqual(Buffer.from(FROM.slice(2), 'hex'));
    expect(row.columns['value']).toBe('123456789');
  });

  it('mismatched data throws DecodeError', () => {
    const [def] = extractEventDefs('usdc', ADDR, TRANSFER_ABI as unknown as unknown[]);
    const bad = { ...makeLog(), data: '0x01' as const };
    expect(() => decodeLogToRow(def!, bad, new Date())).toThrow(DecodeError);
  });
});
