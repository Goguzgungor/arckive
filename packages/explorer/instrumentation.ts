export async function register(): Promise<void> {
  // pg, the tailer and the rollup live in the Node.js runtime only
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { getRuntime } = await import('./lib/runtime.js');
  getRuntime();
}
