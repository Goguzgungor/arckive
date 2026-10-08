// The browser smoke's server: PostgreSQL 17 with the test fixture, the feed,
// and the built explorer (`next build` first) on 127.0.0.1:3107.
import { spawn } from 'node:child_process';
import { startDb } from '../test/fixture/db.ts';
import { startFeed } from './feed.ts';

const db = await startDb({ insights: true });
const stopFeed = startFeed(db.admin);
const next = spawn('node_modules/.bin/next', ['start', '-p', '3107', '-H', '127.0.0.1'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: db.explorerUrl,
    LANE_HOLD_MS: '1500',
    // no RPC in the smoke: token symbols fall back to short addresses
    ARC_RPC: 'http://127.0.0.1:9',
    NEXT_TELEMETRY_DISABLED: '1',
  },
});

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  next.kill('SIGTERM');
  stopFeed();
  await db.stop();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
next.on('exit', close);
