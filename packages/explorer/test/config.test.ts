import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../lib/config.js';

const DSN = 'postgres://explorer:s3cret-pw@pg-explorer:5432/explorer';

describe('loadConfig', () => {
  it('applies the defaults around DATABASE_URL', () => {
    expect(loadConfig({ DATABASE_URL: DSN })).toEqual({
      databaseUrl: DSN,
      schema: 'idx_arc_explorer',
      usdcTable: 'usdc_transfer',
      poolPrefix: 'poolmanager_',
      arcRpc: 'https://rpc.mainnet.arc.io',
      laneHoldMs: 8000,
      maxStreams: 2000,
    });
  });

  it('reads numbers and treats an empty variable as unset', () => {
    const c = loadConfig({ DATABASE_URL: DSN, LANE_HOLD_MS: '2500', MAX_STREAMS: '' });
    expect(c.laneHoldMs).toBe(2500);
    expect(c.maxStreams).toBe(2000);
  });

  it('refuses a missing DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('refuses identifiers the worker would never write', () => {
    expect(() => loadConfig({ DATABASE_URL: DSN, ARCKIVE_SCHEMA: 'Idx-Arc' })).toThrow(/ARCKIVE_SCHEMA/);
    expect(() => loadConfig({ DATABASE_URL: DSN, USDC_TABLE: 'usdc;drop' })).toThrow(/USDC_TABLE/);
  });

  it('refuses a hold that is not a number', () => {
    expect(() => loadConfig({ DATABASE_URL: DSN, LANE_HOLD_MS: 'soon' })).toThrow(/LANE_HOLD_MS/);
  });

  it('never quotes the DSN in an error', () => {
    try {
      loadConfig({ DATABASE_URL: DSN, MAX_STREAMS: '-1' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('s3cret');
    }
  });
});
