import { describe, expect, it } from 'vitest';
import {
  IndexerSpecSchema,
  WorkerConfigSchema,
  configHash,
  renderWorkerConfig,
} from '../src/index.js';

const ADDR = `0x${'ab'.repeat(20)}`;

const raw = {
  network: { chainId: 5042002, rpc: ['https://arc-testnet.drpc.org'] },
  storage: { mode: 'External', external: { dsnSecretRef: { name: 'pg-dsn' } } },
  contracts: [{ name: 'usdc', address: ADDR, abi: { configMapRef: { name: 'usdc-abi' } } }],
};

describe('IndexerSpecSchema', () => {
  it('fills in defaults', () => {
    const spec = IndexerSpecSchema.parse(raw);
    expect(spec.network.finalityTag).toBe('finalized');
    expect(spec.storage.external.dsnSecretRef.key).toBe('url');
    expect(spec.contracts[0]!.abi?.configMapRef?.key).toBe('abi.json');
    expect(spec.contracts[0]!.startBlock).toBeUndefined(); // omitted = tail from head
    expect(spec.contracts[0]!.events).toEqual([]);
    expect(spec.polling).toEqual({ batchBlocks: 1000, intervalMs: 2000 });
  });

  it('rejects an invalid address', () => {
    const bad = { ...raw, contracts: [{ ...raw.contracts[0]!, address: '0x123' }] };
    expect(() => IndexerSpecSchema.parse(bad)).toThrow();
  });

  it('rejects a non-DNS-compliant contract name', () => {
    const bad = { ...raw, contracts: [{ ...raw.contracts[0]!, name: 'My_Token' }] };
    expect(() => IndexerSpecSchema.parse(bad)).toThrow();
  });

  it('rejects an empty contracts list', () => {
    expect(() => IndexerSpecSchema.parse({ ...raw, contracts: [] })).toThrow();
  });

  it('rpc: accepts ws:// and wss:// URLs', () => {
    const ok = {
      ...raw,
      network: { ...raw.network, rpc: ['wss://arc-testnet.drpc.org', 'ws://anvil:8545', 'https://x.example'] },
    };
    expect(IndexerSpecSchema.safeParse(ok).success).toBe(true);
  });

  it('rpc: rejects schemes other than http/ws', () => {
    const bad = { ...raw, network: { ...raw.network, rpc: ['ftp://bad.example'] } };
    expect(IndexerSpecSchema.safeParse(bad).success).toBe(false);
  });

  it('storage.partitionBlocks defaults to 2,000,000 and rejects less than 10,000', () => {
    expect(IndexerSpecSchema.parse(raw).storage.partitionBlocks).toBe(2_000_000);
    const small = { ...raw, storage: { ...raw.storage, partitionBlocks: 9_999 } };
    expect(() => IndexerSpecSchema.parse(small)).toThrow();
  });
});

describe('renderWorkerConfig', () => {
  it('announceRpc passes through from the CR spec to the worker config as-is', () => {
    const spec = IndexerSpecSchema.parse({
      ...raw,
      network: { ...raw.network, announceRpc: ['wss://rpc.testnet.arc.network'] },
    });
    const cfg = renderWorkerConfig('usdc-arc', spec);
    expect(cfg.network.announceRpc).toEqual(['wss://rpc.testnet.arc.network']);
  });

  it('announceRpc defaults to an empty array when omitted', () => {
    const cfg = renderWorkerConfig('usdc-arc', IndexerSpecSchema.parse(raw));
    expect(cfg.network.announceRpc).toEqual([]);
  });


  it('produces a config compatible with WorkerConfigSchema', () => {
    const spec = IndexerSpecSchema.parse(raw);
    const cfg = renderWorkerConfig('usdc-arc', spec);
    expect(() => WorkerConfigSchema.parse(cfg)).not.toThrow();
    expect(cfg.indexerName).toBe('usdc-arc');
    expect(cfg.contracts[0]!.abiPath).toBe('/etc/arckive/abis/usdc/abi.json');
    expect(cfg.network.finalityTag).toBe('finalized');
  });

  it('no abi -> no abiPath, explorerApi defaults from chainId', () => {
    const spec = IndexerSpecSchema.parse({ ...raw, contracts: [{ name: 'usdc', address: ADDR }] });
    const cfg = renderWorkerConfig('usdc-arc', spec);
    expect(cfg.contracts[0]!.abiPath).toBeUndefined();
    expect(cfg.contracts[0]!.abiInline).toBeUndefined();
    expect(cfg.network.explorerApi).toBe('https://testnet.arcscan.app/api/v2');
    expect(() => WorkerConfigSchema.parse(cfg)).not.toThrow();
  });

  it('inline abi -> abiInline, no abiPath', () => {
    const abi = [{ type: 'event', name: 'Transfer', inputs: [] }];
    const spec = IndexerSpecSchema.parse({
      ...raw,
      contracts: [{ name: 'usdc', address: ADDR, abi: { inline: abi } }],
    });
    const cfg = renderWorkerConfig('usdc-arc', spec);
    expect(cfg.contracts[0]!.abiInline).toEqual(abi);
    expect(cfg.contracts[0]!.abiPath).toBeUndefined();
  });

  it('renderWorkerConfig passes storage.partitionBlocks to the worker', () => {
    const spec = IndexerSpecSchema.parse({ ...raw, storage: { ...raw.storage, partitionBlocks: 50_000 } });
    expect(renderWorkerConfig('x', spec).storage).toEqual({ partitionBlocks: 50_000 });
  });

  it('explicit explorerApi overrides the chainId default', () => {
    const spec = IndexerSpecSchema.parse({
      ...raw,
      network: { ...raw.network, explorerApi: 'https://custom.example/api/v2' },
      contracts: [{ name: 'usdc', address: ADDR }],
    });
    expect(renderWorkerConfig('x', spec).network.explorerApi).toBe('https://custom.example/api/v2');
  });
});

describe('configHash', () => {
  it('is deterministic and sensitive to input', () => {
    const spec = IndexerSpecSchema.parse(raw);
    const a = configHash(renderWorkerConfig('usdc-arc', spec));
    const b = configHash(renderWorkerConfig('usdc-arc', spec));
    const c = configHash(renderWorkerConfig('other-name', spec));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('insights', () => {
  const withInsights = {
    ...raw,
    insights: { laya: { url: 'https://laya-gate.example', headerSecretRef: { name: 'laya-gate' } } },
  };

  it('defaults the header key and carries only the URL to the worker', () => {
    const spec = IndexerSpecSchema.parse(withInsights);
    expect(spec.insights?.laya.headerSecretRef?.key).toBe('header');
    const cfg = renderWorkerConfig('demo', spec);
    expect(cfg.insights).toEqual({ laya: { url: 'https://laya-gate.example' } });
    expect(JSON.stringify(cfg)).not.toContain('laya-gate"');
  });

  it('rejects a URL that is not http(s)', () => {
    const bad = { ...raw, insights: { laya: { url: 'ftp://x' } } };
    expect(IndexerSpecSchema.safeParse(bad).success).toBe(false);
  });

  it('without insights the worker config, and so its hash, is what it was before insights existed', () => {
    const cfg = renderWorkerConfig('demo', IndexerSpecSchema.parse(raw));
    expect('insights' in cfg).toBe(false);
    // hash includes storage.partitionBlocks (default 2_000_000)
    expect(configHash(cfg)).toBe('2794d91436dcce97');
  });
});
