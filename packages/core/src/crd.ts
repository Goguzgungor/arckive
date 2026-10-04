import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RpcUrlSchema, WorkerConfigSchema, type WorkerConfig } from './config.js';

export const ABI_MOUNT_DIR = '/etc/arckive/abis';
export const CONFIG_MOUNT_PATH = '/etc/arckive/config/config.json';

// Known Blockscout-style explorer APIs, used to auto-fetch verified ABIs when a
// contract provides no abi. Overridable per-CR via network.explorerApi.
export const DEFAULT_EXPLORER_API: Record<number, string> = {
  5042002: 'https://testnet.arcscan.app/api/v2', // Arc testnet
};

export const IndexerSpecSchema = z.object({
  network: z.object({
    chainId: z.number().int().positive(),
    rpc: z.array(RpcUrlSchema).min(1),
    // ws endpoints listened to for newHeads only — not part of the query pool (CRD
    // counterpart of the worker's announceRpc; renderWorkerConfig passes it through as-is)
    announceRpc: z
      .array(z.string().regex(/^wss?:\/\//i, 'announceRpc must be ws(s):// only'))
      .default([]),
    // Blockscout-style API base for auto-fetching verified ABIs; falls back to
    // DEFAULT_EXPLORER_API[chainId] when omitted.
    explorerApi: z.string().regex(/^https?:\/\//i, 'explorerApi must be http(s)://').optional(),
    finalityTag: z.enum(['finalized', 'safe', 'latest']).default('finalized'),
  }),
  storage: z.object({
    mode: z.literal('External'),
    external: z.object({
      dsnSecretRef: z.object({
        name: z.string().min(1),
        key: z.string().min(1).default('url'),
      }),
    }),
  }),
  contracts: z
    .array(
      z.object({
        // feeds the table name (snake_case) and the K8s volume name — DNS-1123 compliant
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,29}$/, 'contract name: lowercase letters, digits, hyphens; starts with a letter; <=30'),
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'invalid EVM address'),
        // ABI source (all optional): configMapRef (mounted file) or inline. When
        // abi is omitted entirely, the worker auto-fetches the verified ABI from
        // the explorer by address.
        abi: z
          .object({
            configMapRef: z
              .object({
                name: z.string().min(1),
                key: z.string().min(1).default('abi.json'),
              })
              .optional(),
            inline: z.array(z.unknown()).optional(),
          })
          .optional(),
        // omitted = tail from head; negative = head-relative (last |n| blocks); >=0 = absolute
        startBlock: z.number().int().optional(),
        events: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
  polling: z
    .object({
      batchBlocks: z.number().int().positive().default(1000),
      intervalMs: z.number().int().positive().default(2000),
    })
    .default({}),
  // Classify every indexed event's transaction into a lane through a Laya
  // model gate. Only the URL reaches the worker's config; the header (a token)
  // stays in its Secret and is injected as env.
  insights: z
    .object({
      laya: z.object({
        url: z.string().regex(/^https?:\/\//i, 'insights.laya.url must be http(s)://'),
        headerSecretRef: z
          .object({ name: z.string().min(1), key: z.string().min(1).default('header') })
          .optional(),
      }),
    })
    .optional(),
});

export type IndexerSpec = z.infer<typeof IndexerSpecSchema>;

export type IndexerPhase = 'Provisioning' | 'Backfilling' | 'Live' | 'Degraded';

export interface IndexerCondition {
  type: 'Provisioned';
  status: 'True' | 'False';
  reason: string;
  message?: string;
  lastTransitionTime: string;
}

export interface IndexerStatus {
  phase?: IndexerPhase;
  currentBlock?: number;
  headBlock?: number;
  lag?: number;
  lastError?: string;
  observedGeneration?: number;
  conditions?: IndexerCondition[];
}

export function renderWorkerConfig(crName: string, spec: IndexerSpec): WorkerConfig {
  const explorerApi = spec.network.explorerApi ?? DEFAULT_EXPLORER_API[spec.network.chainId];
  return WorkerConfigSchema.parse({
    indexerName: crName,
    network: { ...spec.network, ...(explorerApi ? { explorerApi } : {}) },
    contracts: spec.contracts.map((c) => {
      const cm = c.abi?.configMapRef;
      return {
        name: c.name,
        address: c.address,
        // configMapRef -> mounted file; else inline; else nothing (worker fetches from explorer)
        ...(cm ? { abiPath: `${ABI_MOUNT_DIR}/${c.name}/${cm.key}` } : {}),
        ...(c.abi?.inline ? { abiInline: c.abi.inline } : {}),
        ...(c.startBlock !== undefined ? { startBlock: c.startBlock } : {}),
        events: c.events,
      };
    }),
    polling: spec.polling,
    ...(spec.insights ? { insights: { laya: { url: spec.insights.laya.url } } } : {}),
  });
}

export function configHash(config: WorkerConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}
