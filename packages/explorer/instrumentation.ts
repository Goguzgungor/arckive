export async function register(): Promise<void> {
  // pg, the tailer and the rollup live in the Node.js runtime only
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { getRuntime } = await import('./lib/runtime.js');
  try {
    getRuntime();
  } catch (err) {
    console.error(`arckive-explorer: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
