import { z } from 'zod';

// rpc endpoints: http(s) for polling/reads, ws(s) for newHeads subscription + reads
export const RpcUrlSchema = z
  .string()
  .url()
  .refine(
    (u) => /^(https?|wss?):\/\//i.test(u),
    'rpc URL scheme must be http(s):// or ws(s)://',
  );

export const ContractConfigSchema = z.object({
  name: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'invalid EVM address'),
  // ABI source, resolved in order: abiPath (mounted file) > abiInline >
  // network.explorerApi (auto-fetch the verified ABI by address). All optional;
  // the worker errors at startup if none of the three yields an ABI.
  abiPath: z.string().min(1).optional(),
  abiInline: z.array(z.unknown()).optional(),
  // omitted = tail from head; negative = head-relative (last |n| blocks); >=0 = absolute
  startBlock: z.number().int().optional(),
  events: z.array(z.string().min(1)).default([]),
});

export const WorkerConfigSchema = z.object({
  indexerName: z.string().min(1),
  network: z.object({
    chainId: z.number().int().positive(),
    rpc: z.array(RpcUrlSchema).min(1),
    // extra ws endpoints used only to listen for newHeads (not part of the query pool):
    // for endpoints fast at announcing but limited for queries (e.g. the official endpoint)
    announceRpc: z
      .array(z.string().regex(/^wss?:\/\//i, 'announceRpc must be ws(s):// only'))
      .default([]),
    // Blockscout-style API base (…/api/v2) used to auto-fetch verified contract
    // ABIs when a contract provides no abiPath/abiInline.
    explorerApi: z.string().regex(/^https?:\/\//i, 'explorerApi must be http(s)://').optional(),
    finalityTag: z.enum(['finalized', 'safe', 'latest']).default('finalized'),
  }),
  contracts: z.array(ContractConfigSchema).min(1),
  polling: z
    .object({
      batchBlocks: z.number().int().positive().default(1000),
      intervalMs: z.number().int().positive().default(2000),
    })
    .default({}),
  // Rows are range-partitioned by block_number, partitionBlocks blocks per
  // partition: vacuum and index builds stay per range, and a retention
  // window, if one is ever wanted, is a DROP TABLE.
  storage: z
    .object({
      partitionBlocks: z.number().int().min(10_000).default(2_000_000),
      // absent = false; see IndexerSpecSchema.storage.addressIndexes
      addressIndexes: z.boolean().optional(),
    })
    .default({}),
  // Laya insights (optional): where the model gate is. The header that
  // authenticates to it is a secret and arrives as INSIGHTS_HEADER, never here.
  insights: z
    .object({
      laya: z.object({
        url: z.string().regex(/^https?:\/\//i, 'insights.laya.url must be http(s)://'),
      }),
      rpc: z
        .array(z.string().regex(/^https?:\/\//i, 'insights.rpc entries must be http(s)://'))
        .min(1)
        .max(8)
        .optional(),
      startBlock: z.number().int().optional(),
    })
    .optional(),
});

export type ContractConfig = z.infer<typeof ContractConfigSchema>;
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function parseWorkerConfig(raw: unknown): WorkerConfig {
  return WorkerConfigSchema.parse(raw);
}
