import pino from 'pino';

export type Logger = pino.Logger;

export const log: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', base: { app: 'arckive-explorer' } });

// pg's messages name relations and network addresses, never the DSN's password.
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
