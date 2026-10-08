import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export function createMetrics(indexerName: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ indexer: indexerName });
  return {
    registry,
    blocksBehind: new Gauge({
      name: 'arckive_blocks_behind',
      help: 'block gap between the finalized head and the cursor',
      registers: [registry],
    }),
    lastProcessedBlock: new Gauge({
      name: 'arckive_last_processed_block',
      help: 'last processed block number',
      registers: [registry],
    }),
    eventsIngested: new Counter({
      name: 'arckive_events_ingested_total',
      help: 'total number of events written',
      registers: [registry],
    }),
    rpcErrors: new Counter({
      name: 'arckive_rpc_errors_total',
      help: 'number of RPC errors',
      registers: [registry],
    }),
    deadLetters: new Counter({
      name: 'arckive_dead_letter_total',
      help: 'number of logs sent to the dead-letter table',
      registers: [registry],
    }),
    wsConnected: new Gauge({
      name: 'arckive_ws_connected',
      help: 'whether the newHeads WS subscription is connected (0/1)',
      registers: [registry],
    }),
    headNotifications: new Counter({
      name: 'arckive_head_notifications_total',
      help: 'number of newHeads notifications received',
      registers: [registry],
    }),
    writeLatency: new Histogram({
      name: 'arckive_write_latency_seconds',
      help: 'batch commit duration',
      registers: [registry],
    }),
    insightsBlocksBehind: new Gauge({
      name: 'arckive_insights_blocks_behind',
      help: 'block gap between the ingest cursor and the insights cursor',
      registers: [registry],
    }),
    insightsClassified: new Counter({
      name: 'arckive_insights_classified_total',
      help: 'insight rows written, by lane',
      labelNames: ['lane'] as const,
      registers: [registry],
    }),
    insightsModelCalls: new Counter({
      name: 'arckive_insights_model_calls_total',
      help: 'calls made to the Laya gate',
      registers: [registry],
    }),
    insightsCacheHits: new Counter({
      name: 'arckive_insights_cache_hits_total',
      help: 'sentences answered from the cache instead of the gate',
      registers: [registry],
    }),
    insightsErrors: new Counter({
      name: 'arckive_insights_errors_total',
      help: 'failed insight rounds, by stage (model, rpc, db)',
      labelNames: ['stage'] as const,
      registers: [registry],
    }),
    insightsRpcRequests: new Counter({
      name: 'arckive_insights_rpc_requests_total',
      help: 'requests the insight RPC pool sent, by endpoint index and outcome (ok, rate_limited, failed)',
      labelNames: ['endpoint', 'outcome'] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
