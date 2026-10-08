// @ts-check
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  // The workspace root, so the standalone build traces @arckive/core from packages/core.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  serverExternalPackages: ['pg', 'pino'],
  // The repository's root `pnpm lint` covers this package.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  webpack: (cfg) => {
    // Relative imports carry .js (the repository's ESM convention); resolve them to the .ts/.tsx sources.
    cfg.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return cfg;
  },
};

export default config;
