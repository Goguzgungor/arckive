# Arckive Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js explorer (`packages/explorer`) that shows Arckive's own archive of Arc mainnet native USDC transfers and Uniswap v4 PoolManager events: a live tape on the home page (SSE fed by one server-side database tailer), a transaction page, an address page over the whole history, and search.

**Architecture:** One Node process (Next.js 15 standalone) serves pages, `/api/stream` and two background jobs that start once per process from `instrumentation.ts` and live on `globalThis`: the **tailer** (every 250 ms, releases blocks up to the insights cursor or after `LANE_HOLD_MS`, publishes them to a hub that fans out to SSE viewers) and the **rollup** (folds `usdc_transfer` into `explorer.address_daily`). It reads the worker's schema `idx_arc_explorer` as a read-only role `explorer` and owns a schema `explorer`. All data logic is plain TypeScript modules in `lib/` with vitest tests; React components only render.

**Tech Stack:** Next.js 15.5 (App Router, React 19, `output: 'standalone'`), TypeScript ESM, `pg` (no ORM), zod, pino, viem (token metadata only), vitest + `@testcontainers/postgresql` (PostgreSQL 17), Playwright (local smoke only).

**Spec:** `docs/superpowers/specs/2026-10-08-arckive-explorer-design.md` (mockups in `docs/superpowers/specs/2026-10-08-arckive-explorer-mockups/`).

## Global Constraints

- Node >= 22, pnpm 10.12.1 through `corepack pnpm` (pnpm is not on PATH). Run commands from the worktree root `/Users/gokbot/Documents/projects/arclight-explorer` unless a step says otherwise.
- `next` stays on the 15.x line (`^15.5.27`), React 19. No ORM, no CSS framework, no PostgreSQL extensions (pure PostgreSQL, 15+; tests use `postgres:17-alpine`).
- TypeScript ESM. Relative imports carry `.js` (`./format.js`, also for `.tsx` files: `./Masthead.js`) **except** under `packages/explorer/test/fixture/` and `packages/explorer/smoke/`, which import each other with `.ts` because `smoke/serve.ts` runs them under Node's type stripping. Type-only imports use `import type`. Env vars are read with bracket notation (`process.env['X']`).
- `@arckive/core` is imported only by server modules (`lib/lanewhy.ts`, tests). Modules a client component imports must stay client-safe — no `pg`, no `@arckive/core`, no `lib/runtime.ts`: these are `lib/format.ts`, `lib/lanes.ts`, `lib/names.ts`, `lib/search.ts`, `lib/types.ts`, `lib/parts.ts`, `lib/pacing.ts`, `lib/stream-client.ts`, `lib/homestory.ts`, `lib/live.ts`, and the components without database access.
- The explorer never writes to the worker's schema. All identifiers are double-quoted; all values go through parameterized queries. Dates are selected as `::text`, block times as epoch seconds (`extract(epoch from …)::bigint`), amounts as `::text` — `pg` parses `date` into a local-time `Date`.
- Amounts never pass through a float: integer strings in a token's smallest unit (native USDC: 18 decimals) → `unitsToDecimal` → `fmtAmount`. Floats only for chart heights, percentages and `perSec`.
- Values from the spec: `LANE_HOLD_MS` 8000; `MAX_STREAMS` 2000; tailer every 250 ms; `stats` once a second; heartbeat every 15 s; hub buffer 40 movements; tape 32 rows; history 25 per page by keyset `?before=<block>-<log>`; counterparties and lanes over the latest 1,000 movements; rollup ranges up to 50,000 blocks, every 2 s once caught up; `statement_timeout` 5 s for the role; pool of 10; lane polling every 2 s for up to 30 s; pacing over the median gap of the last 20 blocks, backlog over 3 s drained faster; the tape hides `from → to` below 520 px.
- Visual tokens (spec "Visual system"): paper `#f4f1ea`, sheet `#faf8f3`, ink `#15171b`, dim `#5b616c`, faint `#8b8f97`, hair `#ddd6c9`, rule `#c9c1b2`; in `#1d8a57`, out `#b2412f`; lane inks payment `#3550c8`, swap `#7442d1`, bridge `#0b7fb0`, liquidity `#1d8a57`, vault `#8d55e8`, lending `#a87800`, signed payment `#2a7fa8`, issuance `#c06a12`, spam `#8b8f97`. Fonts through `next/font/google` (self-hosted at build). Times in UTC, labelled.
- Every `<Link>` to a transaction or address page carries `prefetch={false}`: the tape adds ~14 links a second, and Next prefetches every link that scrolls into view.
- Contract or wallet is never claimed for an address (no call is made to know); only names from `lib/names.ts` (verified on Arc's explorer) are shown.
- Repository language is English. Conventional Commits. Every commit message ends with these two lines (after a blank line):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg
  ```
- Before committing: `corepack pnpm lint` passes and the package's tests pass. Never commit secrets (DSNs, passwords, tokens).

## Review Focus

1. **Lanes not switched on yet** (no `_insights*` tables — the state the explorer starts in): tailer, transaction page and address page must work without them; queries must not reference them. Pinned in Tasks 5, 7 and 9 (`insights: false` cases).
2. **A stream the browser gives up on** (503 above `MAX_STREAMS`, network loss): the client must keep retrying with backoff and resume with `?last=`, never stop for good. Pinned in Task 11 (`stream-client` tests).
3. **Hand-typed URLs**: `/address/0xABC…` in mixed case or with surrounding whitespace, a malformed `?before=` — normalised or ignored, never a 500. Pinned in Tasks 2 (`parseAddress`, `parseTxHash`) and 7 (`parseBefore`).
4. **Extreme amounts**: 78-digit `numeric` values, 1 wei, negative swap deltas, a token without decimals — exact text, no float, no `NaN`. Pinned in Tasks 2 (`format`) and 6 (`swapView`).
5. **A dense backfill range** whose fold outlives the statement timeout: the rollup halves its span and keeps going instead of failing forever. Pinned in Task 4 (span halving on `57014`).

---

## File map

```
packages/explorer/
  package.json, tsconfig.json, next.config.mjs, vitest.config.ts, instrumentation.ts
  app/layout.tsx, app/globals.css, app/page.tsx, app/error.tsx, app/not-found.tsx
  app/tx/[hash]/page.tsx, app/tx/[hash]/not-found.tsx
  app/address/[address]/page.tsx, app/address/[address]/not-found.tsx
  app/api/stream/route.ts, app/api/tx/[hash]/lane/route.ts, app/api/health/route.ts
  components/  Masthead, SearchBox (client), Status, Dateline, Footer, LaneTag, Addr, Parts,
               HomeLive (client), LanePanel (client), Flow, SwapBox, DayChart
  lib/ (server)  config, log, db, schema, explorer-schema, rollup, tokens, tx, lanewhy, txstory,
                 address, addrstory, release, window, hub, sse, tailer, streamroute, runtime
  lib/ (client-safe)  format, lanes, names, search, types, parts, pacing, stream-client, homestory, live
  test/fixture/db.ts, test/fixture/rows.ts, test/*.test.ts
  smoke/playwright.config.ts, smoke/serve.ts, smoke/feed.ts, smoke/smoke.spec.ts
manifests/arc-mainnet/k8s/explorer-role.sql, manifests/arc-mainnet/k8s/explorer-app.yaml
Dockerfile (explorer target), .dockerignore, eslint.config.js, .gitignore, README.md, CLAUDE.md
```

---

### Task 1: Package scaffold and configuration

**Files:**
- Create: `packages/explorer/package.json`, `packages/explorer/tsconfig.json`, `packages/explorer/next.config.mjs`, `packages/explorer/vitest.config.ts`, `packages/explorer/app/layout.tsx`, `packages/explorer/app/page.tsx`, `packages/explorer/lib/config.ts`
- Test: `packages/explorer/test/config.test.ts`
- Modify: `eslint.config.js`, `.gitignore`, `pnpm-lock.yaml` (by install)

**Interfaces:**
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config`, `class ConfigError extends Error`, `interface Config { databaseUrl: string; schema: string; usdcTable: string; poolPrefix: string; arcRpc: string; laneHoldMs: number; maxStreams: number }`.

- [ ] **Step 1: Create the package files**

`packages/explorer/package.json`:

```json
{
  "name": "@arckive/explorer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "next build",
    "dev": "next dev",
    "start": "next start",
    "test": "vitest run",
    "smoke": "playwright test -c smoke/playwright.config.ts"
  },
  "dependencies": {
    "@arckive/core": "workspace:*",
    "next": "^15.5.27",
    "pg": "^8.16.0",
    "pino": "^9.7.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "viem": "^2.31.3",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@testcontainers/postgresql": "^11.0.3",
    "@types/pg": "^8.15.4",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0"
  }
}
```

`packages/explorer/tsconfig.json` (Next's required options; `bundler` resolution because `next/link` and friends have no `exports` map that NodeNext could resolve):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["dom", "dom.iterable", "es2023"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "incremental": true,
    "jsx": "preserve",
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "app/**/*.ts", "app/**/*.tsx", "components/**/*.ts", "components/**/*.tsx", "lib/**/*.ts", "instrumentation.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "test", "smoke"]
}
```

`packages/explorer/next.config.mjs`:

```js
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
```

`packages/explorer/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@arckive/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 },
});
```

`packages/explorer/app/layout.tsx` (placeholder; Task 10 replaces it):

```tsx
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`packages/explorer/app/page.tsx` (placeholder; Task 11 replaces it):

```tsx
export default function Home() {
  return <main>Arckive Explorer</main>;
}
```

- [ ] **Step 2: Ignore build output in lint and git**

In `eslint.config.js`, extend the ignores:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/fixtures/**', '**/.next/**', '**/next-env.d.ts', '**/playwright-report/**', '**/test-results/**'] },
  ...tseslint.configs.recommended,
);
```

Append to `.gitignore`:

```
.next/
next-env.d.ts
packages/explorer/smoke/screenshots/
playwright-report/
test-results/
```

- [ ] **Step 3: Install**

Run: `corepack pnpm install`
Expected: lockfile updated, no errors (warnings about ignored build scripts such as `sharp` are fine — the explorer does not use `next/image`).

- [ ] **Step 4: Write the failing config test**

`packages/explorer/test/config.test.ts`:

```ts
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
```

- [ ] **Step 5: Run it to see it fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/config.test.ts`
Expected: FAIL — `Cannot find module '../lib/config.js'`.

- [ ] **Step 6: Implement `lib/config.ts`**

```ts
import { z } from 'zod';

export class ConfigError extends Error {}

// A SQL identifier the explorer quotes into its queries: lowercase, as the
// worker's naming writes it, so a typo stops the process here rather than
// surfacing as a 500 on the first page that needs the table.
const Ident = z.string().regex(/^[a-z_][a-z0-9_]*$/, 'must be a lowercase SQL identifier');

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'is required'),
  ARCKIVE_SCHEMA: Ident.default('idx_arc_explorer'),
  USDC_TABLE: Ident.default('usdc_transfer'),
  POOL_TABLE_PREFIX: Ident.default('poolmanager_'),
  ARC_RPC: z.string().url().default('https://rpc.mainnet.arc.io'),
  LANE_HOLD_MS: z.coerce.number().int().min(0).max(60_000).default(8000),
  MAX_STREAMS: z.coerce.number().int().positive().default(2000),
});

export interface Config {
  databaseUrl: string;
  schema: string;
  usdcTable: string;
  poolPrefix: string;
  arcRpc: string;
  laneHoldMs: number;
  maxStreams: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // an exported-but-empty variable means "unset", not 0
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const r = EnvSchema.safeParse(present);
  if (!r.success) {
    // zod's messages name the variable and the rule, never the value: the DSN carries a password
    const why = r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
    throw new ConfigError(`explorer configuration: ${why}`);
  }
  const e = r.data;
  for (const name of [e.ARCKIVE_SCHEMA, e.USDC_TABLE, `${e.POOL_TABLE_PREFIX}modify_liquidity`]) {
    if (Buffer.byteLength(name) > 63) throw new ConfigError(`explorer configuration: ${name} exceeds 63 bytes`);
  }
  return {
    databaseUrl: e.DATABASE_URL,
    schema: e.ARCKIVE_SCHEMA,
    usdcTable: e.USDC_TABLE,
    poolPrefix: e.POOL_TABLE_PREFIX,
    arcRpc: e.ARC_RPC,
    laneHoldMs: e.LANE_HOLD_MS,
    maxStreams: e.MAX_STREAMS,
  };
}
```

- [ ] **Step 7: Run the tests, the build and lint**

Run: `corepack pnpm --filter @arckive/explorer test -- test/config.test.ts`
Expected: PASS (6 tests).

Run: `corepack pnpm --filter @arckive/core build && NEXT_TELEMETRY_DISABLED=1 corepack pnpm --filter @arckive/explorer build`
Expected: `next build` completes. If it rewrites `tsconfig.json` (it may add options it requires), keep its edits.

Run: `corepack pnpm lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/explorer eslint.config.js .gitignore pnpm-lock.yaml
git commit -m "feat(explorer): scaffold the Next.js package and its configuration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 2: Display modules — format, lanes, names, search, message types

**Files:**
- Create: `packages/explorer/lib/format.ts`, `lib/lanes.ts`, `lib/names.ts`, `lib/search.ts`, `lib/types.ts`, `lib/parts.ts`
- Test: `packages/explorer/test/format.test.ts`, `test/lanes.test.ts`, `test/search.test.ts`

**Interfaces:**
- Produces (all client-safe):
  - `format.ts`: `unitsToDecimal(raw: string | bigint, decimals?: number): string`, `fmtAmount(dec: string): string`, `fmtWhole(dec: string): string`, `fmtSigned(dec: string): string`, `fmtInt(n: number | bigint | string): string`, `fmtTime(unix: number): string`, `fmtDateTime(unix: number): string`, `fmtStamp(unix: number): string`, `fmtDateLong(d: Date): string`, `fmtDay(day: string): string`, `dayOf(unix: number): string`, `shortAddr(a: string): string`, `shortHash(h: string): string`, `fmtBytes(n: number): string`, `fmtFee(fee: number): string`, `pct(part: number, total: number): number`, `ZERO_ADDRESS`.
  - `lanes.ts`: `interface LaneMeta { label: string; ink: string; plural: string }`, `LANE_META`, `LANE_ORDER: readonly string[]`, `LANES_ALWAYS: readonly string[]`, `laneMeta(lane: string | null): LaneMeta`.
  - `names.ts`: `NAMES: Readonly<Record<string, string>>`, `nameOf(address: string): string | undefined`, `POOLMANAGER`.
  - `search.ts`: `type SearchRoute = { href: string } | { hint: string }`, `SEARCH_HINT`, `routeSearch(input: string): SearchRoute`, `parseTxHash(s: string): string | null`, `parseAddress(s: string): string | null`, `decodeParam(s: string): string`.
  - `types.ts`: `Move`, `BlockMsg`, `Largest`, `StatsMsg`, `Hello`, `LaneState` (below).
  - `parts.ts`: `type Part = string | { b: string } | { addr: string }`.

- [ ] **Step 1: Verify the contract names against Arc's explorer**

Arc mainnet's explorer is Blockscout at `https://explorer.arc.io` (behind Cloudflare, which answers a bare client with a challenge page; a browser User-Agent passes). For each candidate, read `name` and `is_verified`:

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
for a in 0x8366a39cc670b4001a1121b8f6a443a643e40951 0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1 0x000000000022d473030f116ddee9f6b43ac78ba3; do
  for i in 1 2 3 4 5; do
    out=$(curl -s -m 15 -A "$UA" -H 'Accept: application/json' "https://explorer.arc.io/api/v2/addresses/$a")
    echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); print('$a', d.get('name'), d.get('is_verified'))" 2>/dev/null && break
    sleep $((i * 3))
  done
done
```

Keep only addresses printed with `True`. The display names are fixed: PoolManager → `Uniswap v4 Pools` (the spec's name), Universal Router (`0x4fca…9fb1`) → `Uniswap Router`, Permit2 → `Permit2`. If an address prints `False`/`None`, leave it out of `NAMES`. (The controller may run this step and hand the result to the implementer.)

- [ ] **Step 2: Write the failing tests**

`packages/explorer/test/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  dayOf, fmtAmount, fmtBytes, fmtDateLong, fmtDateTime, fmtDay, fmtFee, fmtInt, fmtSigned, fmtStamp, fmtTime,
  fmtWhole, pct, shortAddr, shortHash, unitsToDecimal,
} from '../lib/format.js';

describe('unitsToDecimal', () => {
  it('turns 18-decimal integers into exact decimals', () => {
    expect(unitsToDecimal('476932500000000000000')).toBe('476.9325');
    expect(unitsToDecimal('0')).toBe('0');
    expect(unitsToDecimal('1')).toBe('0.000000000000000001');
    expect(unitsToDecimal(-476932500000000000000n)).toBe('-476.9325');
    expect(unitsToDecimal('1500000', 6)).toBe('1.5');
    expect(unitsToDecimal('42', 0)).toBe('42');
  });

  it('keeps a 78-digit numeric exact', () => {
    expect(unitsToDecimal(`1${'0'.repeat(77)}`)).toBe(`1${'0'.repeat(59)}`);
  });
});

describe('amounts', () => {
  it('shows two decimals with separators, rounding half up', () => {
    expect(fmtAmount('476.9325')).toBe('476.93');
    expect(fmtAmount('13763833.330793760056038261')).toBe('13,763,833.33');
    expect(fmtAmount('0.995')).toBe('1.00');
    expect(fmtAmount('1234567.005')).toBe('1,234,567.01');
    expect(fmtAmount('0')).toBe('0.00');
    expect(fmtAmount('-5.5')).toBe('−5.50');
  });

  it('shows a nonzero amount under a cent as <0.01', () => {
    expect(fmtAmount('0.0049')).toBe('<0.01');
    expect(fmtAmount('0.000000000000000001')).toBe('<0.01');
  });

  it('rounds the headline total to whole USDC', () => {
    expect(fmtWhole('13680.49')).toBe('13,680');
    expect(fmtWhole('13680.5')).toBe('13,681');
  });

  it('signs a net amount', () => {
    expect(fmtSigned('0.004')).toBe('+<0.01');
    expect(fmtSigned('-260.5')).toBe('−260.50');
    expect(fmtSigned('0')).toBe('0.00');
  });

  it('groups integers of any size', () => {
    expect(fmtInt(24787775)).toBe('24,787,775');
    expect(fmtInt(13763833330793760056038261n)).toBe('13,763,833,330,793,760,056,038,261');
    expect(fmtInt('999')).toBe('999');
  });

  it('formats a v4 fee and a share', () => {
    expect(fmtFee(2500)).toBe('0.25%');
    expect(fmtFee(100)).toBe('0.01%');
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBe(0);
  });
});

describe('times, in UTC', () => {
  const t = 1791405212; // 2026-10-07T20:33:32Z
  it('formats block times', () => {
    expect(fmtTime(t)).toBe('20:33:32');
    expect(fmtDateTime(t)).toBe('2026-10-07 20:33:32 UTC');
    expect(fmtStamp(t)).toBe('2026-10-07 20:33');
    expect(dayOf(t)).toBe('2026-10-07');
  });
  it('writes the dateline and days', () => {
    expect(fmtDateLong(new Date('2026-10-07T23:59:00Z'))).toBe('Wednesday, 7 October 2026');
    expect(fmtDay('2026-06-03')).toBe('3 June 2026');
  });
});

describe('short forms', () => {
  it('shortens addresses and hashes', () => {
    expect(shortAddr('0x5e2928212630ccd57bc53f0df428fb678c0da2b7')).toBe('0x5e29…a2b7');
    expect(shortHash('0x6c96ee62f2fcebe56264711c18d20e89bed338d4f055628313c9086f3add79e8')).toBe('0x6c96ee62…dd79e8');
  });
  it('writes database sizes', () => {
    expect(fmtBytes(13_200_000_000)).toBe('13.2 GB');
    expect(fmtBytes(8_790_000)).toBe('8.8 MB');
    expect(fmtBytes(512)).toBe('512 B');
  });
});
```

`packages/explorer/test/lanes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LANES } from '@arckive/core';
import { LANE_META, LANE_ORDER, LANES_ALWAYS, laneMeta } from '../lib/lanes.js';
import { NAMES, nameOf } from '../lib/names.js';

describe('lanes', () => {
  it("starts with core's LANES in their measured order, then the ruled lanes", () => {
    const model = Object.keys(LANES);
    expect(LANE_ORDER.slice(0, model.length)).toEqual(model);
    expect(LANE_ORDER.slice(model.length)).toEqual(['issuance', 'uncertain', 'no_transfer']);
  });

  it('has a label, ink and plural for every lane', () => {
    for (const lane of LANE_ORDER) expect(LANE_META[lane], lane).toMatchObject({ label: expect.any(String), ink: expect.stringMatching(/^#[0-9a-f]{6}$/), plural: expect.any(String) });
    expect(LANES_ALWAYS.every((l) => LANE_ORDER.includes(l))).toBe(true);
  });

  it("uses the spec's inks", () => {
    expect(LANE_META['payment']!.ink).toBe('#3550c8');
    expect(LANE_META['swap']!.ink).toBe('#7442d1');
    expect(LANE_META['signed_payment']!.ink).toBe('#2a7fa8');
    expect(LANE_META['issuance']!.ink).toBe('#c06a12');
  });

  it('falls back for a lane it does not know and for no lane', () => {
    expect(laneMeta('teleport')).toEqual({ label: 'teleport', ink: '#8b8f97', plural: 'teleport' });
    expect(laneMeta(null).label).toBe('—');
  });
});

describe('names', () => {
  it('names the PoolManager and the zero address, lowercase keys only', () => {
    expect(nameOf('0x8366A39CC670B4001A1121B8F6A443A643E40951')).toBe('Uniswap v4 Pools');
    expect(nameOf('0x0000000000000000000000000000000000000000')).toBe('Mint / burn');
    expect(nameOf('0x1111111111111111111111111111111111111111')).toBeUndefined();
    for (const k of Object.keys(NAMES)) expect(k).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
```

`packages/explorer/test/search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SEARCH_HINT, decodeParam, parseAddress, parseTxHash, routeSearch } from '../lib/search.js';

const TX = '0x9a833894c76d093d304e8e907ae79a37ddaac7753fa9855df456643eba0f015a';
const ADDR = '0x5e2928212630ccd57bc53f0df428fb678c0da2b7';

describe('routeSearch', () => {
  it('routes a transaction hash, in any case and with spaces around it', () => {
    expect(routeSearch(TX)).toEqual({ href: `/tx/${TX}` });
    expect(routeSearch(`  ${TX.toUpperCase().replace('0X', '0x')} `)).toEqual({ href: `/tx/${TX}` });
  });
  it('routes an address', () => {
    expect(routeSearch(ADDR.toUpperCase().replace('0X', '0x'))).toEqual({ href: `/address/${ADDR}` });
  });
  it('hints at anything else', () => {
    for (const s of ['', 'hello', '0x123', TX.slice(2), `${ADDR}00`, `0x${'g'.repeat(40)}`]) expect(routeSearch(s)).toEqual({ hint: SEARCH_HINT });
  });
});

describe('URL params', () => {
  it('normalises hand-typed hashes and addresses', () => {
    expect(parseTxHash(` ${TX.toUpperCase().replace('0X', '0x')}`)).toBe(TX);
    expect(parseAddress(`${ADDR.toUpperCase().replace('0X', '0x')}  `)).toBe(ADDR);
  });
  it('decodes a typed URL segment and survives a malformed one', () => {
    expect(parseAddress(decodeParam(`%20${ADDR}%20`))).toBe(ADDR);
    expect(decodeParam('%E0%A4%A')).toBe('%E0%A4%A');
    expect(parseAddress(decodeParam('%E0%A4%A'))).toBeNull();
  });
  it('refuses anything that is not one', () => {
    expect(parseTxHash(ADDR)).toBeNull();
    expect(parseAddress(TX)).toBeNull();
    expect(parseAddress(`0x${'z'.repeat(40)}`)).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/format.test.ts test/lanes.test.ts test/search.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the modules**

`packages/explorer/lib/format.ts`:

```ts
// Amounts arrive as integer strings in a token's smallest unit (native USDC:
// 18 decimals) and never pass through a float: above 2^53 wei (0.009 USDC) a
// float drops digits, and the explorer shows sums of millions of them.

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function unitsToDecimal(raw: string | bigint, decimals = 18): string {
  let v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const frac = decimals ? (v % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${v / base}${frac ? `.${frac}` : ''}`;
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// [negative, |value| scaled by 10^places rounded half up, nonzero]
function scaled(dec: string, places: number): [boolean, bigint, boolean] {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(dec.trim());
  if (!m) throw new RangeError(`not a decimal: ${dec}`);
  const int = m[2]!;
  const frac = m[3] ?? '';
  let v = BigInt(int + (frac + '0'.repeat(places)).slice(0, places));
  if ((frac[places] ?? '0') >= '5') v += 1n;
  const nonzero = /[1-9]/.test(int + frac);
  return [m[1] === '-' && nonzero, v, nonzero];
}

// Two decimals with thousands separators; "<0.01" for a nonzero amount under a cent.
export function fmtAmount(dec: string): string {
  const [neg, cents, nonzero] = scaled(dec, 2);
  const sign = neg ? '−' : '';
  if (cents === 0n) return nonzero ? `${sign}<0.01` : '0.00';
  return `${sign}${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export function fmtWhole(dec: string): string {
  const [neg, units] = scaled(dec, 0);
  return `${neg && units > 0n ? '−' : ''}${group(units.toString())}`;
}

export function fmtSigned(dec: string): string {
  const [neg, , nonzero] = scaled(dec, 2);
  if (!nonzero) return '0.00';
  return neg ? fmtAmount(dec) : `+${fmtAmount(dec)}`;
}

export function fmtInt(n: number | bigint | string): string {
  const s = String(n);
  return s.startsWith('-') ? `−${group(s.slice(1))}` : group(s);
}

// v4 fees are in hundredths of a basis point: 2500 = 0.25%.
export function fmtFee(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

export function pct(part: number, total: number): number {
  return total > 0 ? Math.round((100 * part) / total) : 0;
}

const iso = (unix: number): string => new Date(unix * 1000).toISOString();
export const fmtTime = (unix: number): string => iso(unix).slice(11, 19);
export const fmtDateTime = (unix: number): string => `${iso(unix).slice(0, 10)} ${fmtTime(unix)} UTC`;
export const fmtStamp = (unix: number): string => `${iso(unix).slice(0, 10)} ${iso(unix).slice(11, 16)}`;
export const dayOf = (unix: number): string => iso(unix).slice(0, 10);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function fmtDateLong(d: Date): string {
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// 'YYYY-MM-DD' → '3 June 2026'
export function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string): string => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}
```

`packages/explorer/lib/lanes.ts`:

```ts
// How each lane is shown. Keys are the lanes the worker writes: core's LANES
// (the model's choice set) and the ruled ones. Kept free of @arckive/core so
// client components can import it; test/lanes.test.ts holds it to core's order.
export interface LaneMeta {
  label: string;
  ink: string;
  plural: string;
}

const FAINT = '#8b8f97';

export const LANE_META: Readonly<Record<string, LaneMeta>> = {
  swap: { label: 'Swap', ink: '#7442d1', plural: 'swaps' },
  bridge: { label: 'Bridge', ink: '#0b7fb0', plural: 'bridge transfers' },
  liquidity: { label: 'Liquidity', ink: '#1d8a57', plural: 'liquidity changes' },
  vault: { label: 'Vault', ink: '#8d55e8', plural: 'vault moves' },
  lending: { label: 'Lending', ink: '#a87800', plural: 'lending moves' },
  signed_payment: { label: 'Signed payment', ink: '#2a7fa8', plural: 'signed payments' },
  payment: { label: 'Payment', ink: '#3550c8', plural: 'payments' },
  spam: { label: 'Dust', ink: FAINT, plural: 'dust' },
  issuance: { label: 'Mint / burn', ink: '#c06a12', plural: 'mints and burns' },
  uncertain: { label: 'Uncertain', ink: FAINT, plural: 'uncertain movements' },
  no_transfer: { label: 'No transfer', ink: FAINT, plural: 'events without a transfer' },
};

// core's LANES order (the order is part of the measured question), then the ruled lanes
export const LANE_ORDER: readonly string[] = [
  'swap', 'bridge', 'liquidity', 'vault', 'lending', 'signed_payment', 'payment', 'spam',
  'issuance', 'uncertain', 'no_transfer',
];

// shown in "By lane" even at 0%; the others only when present
export const LANES_ALWAYS: readonly string[] = [
  'swap', 'bridge', 'liquidity', 'vault', 'lending', 'signed_payment', 'payment', 'spam', 'issuance',
];

export function laneMeta(lane: string | null): LaneMeta {
  if (lane === null) return { label: '—', ink: FAINT, plural: '' };
  return LANE_META[lane] ?? { label: lane.replace(/_/g, ' '), ink: FAINT, plural: lane.replace(/_/g, ' ') };
}
```

`packages/explorer/lib/names.ts` (entries per Step 1; drop any address that was not verified):

```ts
// Contracts verified on Arc's explorer (explorer.arc.io, Blockscout) when this
// map was written — an unverified address is never named. The zero address is
// no contract: it is the other party of every mint and burn.
export const POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

export const NAMES: Readonly<Record<string, string>> = {
  '0x0000000000000000000000000000000000000000': 'Mint / burn',
  [POOLMANAGER]: 'Uniswap v4 Pools',
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1': 'Uniswap Router',
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
};

export function nameOf(address: string): string | undefined {
  return NAMES[address.toLowerCase()];
}
```

`packages/explorer/lib/search.ts`:

```ts
export type SearchRoute = { href: string } | { hint: string };

export const SEARCH_HINT = 'Paste a transaction hash (0x and 64 hex characters) or an address (0x and 40).';

const TX = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

// A dynamic route segment as typed: %20 and friends decoded; a malformed
// escape is left as it is (and then fails the parse) instead of throwing.
export function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseTxHash(s: string): string | null {
  const v = s.trim().toLowerCase();
  return TX.test(v) ? v : null;
}

export function parseAddress(s: string): string | null {
  const v = s.trim().toLowerCase();
  return ADDRESS.test(v) ? v : null;
}

// No partial matching in v1: natural-language search (sub-project D) brings questions.
export function routeSearch(input: string): SearchRoute {
  const tx = parseTxHash(input);
  if (tx) return { href: `/tx/${tx}` };
  const address = parseAddress(input);
  if (address) return { href: `/address/${address}` };
  return { hint: SEARCH_HINT };
}
```

`packages/explorer/lib/parts.ts`:

```ts
// A sentence as data: plain text, a bold run, or an address (rendered as its
// name or short form, linked to its page). Pages render it; tests read it.
export type Part = string | { b: string } | { addr: string };
```

`packages/explorer/lib/types.ts`:

```ts
// What /api/stream sends and the pages pass to client components.

export interface Move {
  tx: string; // 0x… transaction hash
  li: number; // log index
  from: string; // 0x… lowercase
  to: string;
  fromName?: string;
  toName?: string;
  value: string; // USDC as an exact decimal string
  lane: string | null; // null: released before its lane was read
}

export interface BlockMsg {
  n: number; // block number, also the SSE id
  t: number; // block time, unix seconds
  moves: Move[];
}

export interface Largest extends Move {
  n: number;
  t: number;
}

export interface StatsMsg {
  count: number;
  usdc: string; // exact decimal
  perSec: number;
  lanes: Record<string, number>;
  largest: Largest[];
  now: number; // server clock, ms — the browser's offset for "n s behind"
}

export interface Hello {
  blocks: BlockMsg[];
  stats: StatsMsg | null;
}

export type LaneState =
  | { kind: 'read'; lane: string; p: number | null; ruled: boolean; sentence: string; why: string }
  | { kind: 'pending' } // above the insights cursor: Laya has not read it yet
  | { kind: 'before'; since: number } // older than the first lane; since = that block's time
  | { kind: 'none' } // inside the read range but without a lane
  | { kind: 'off' }; // lanes are not read on this archive
```

- [ ] **Step 5: Run the tests**

Run: `corepack pnpm --filter @arckive/explorer test -- test/format.test.ts test/lanes.test.ts test/search.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): amount, time, lane, name and search helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 3: Database access — the role, the fixture, the start-up checks

**Files:**
- Create: `manifests/arc-mainnet/k8s/explorer-role.sql`, `packages/explorer/lib/db.ts`, `lib/schema.ts`, `lib/explorer-schema.ts`, `packages/explorer/test/fixture/rows.ts`, `test/fixture/db.ts`
- Test: `packages/explorer/test/db.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces:
  - `db.ts`: `q(id: string): string`, `createPool(cfg: Pick<Config, 'databaseUrl'>): pg.Pool`, `interface Tables { schema; usdc; blocks; addresses; cursor; insights; insightsCursor; insightsFull; swap; initialize; modifyLiquidity; donate: string; names: { usdc; swap; initialize; modifyLiquidity; donate: string } }` (qualified, quoted names; `names` unqualified), `tables(cfg: Pick<Config, 'schema' | 'usdcTable' | 'poolPrefix'>): Tables`, `hexToBytes(hex: string): Buffer`, `bytesToHex(b: Buffer): string`.
  - `schema.ts`: `class SchemaError extends Error`, `checkSchema(pool: pg.Pool, t: Tables): Promise<void>`, `hasInsights(pool: pg.Pool, t: Tables): Promise<boolean>`.
  - `explorer-schema.ts`: `ensureExplorerSchema(pool: pg.Pool): Promise<void>` (tables `explorer.address_daily`, `explorer.rollup_cursor`, `explorer.tokens`).
  - fixture: `startDb(opts?: { insights?: boolean }): Promise<TestDb>` with `interface TestDb { admin: pg.Pool; explorer: pg.Pool; adminUrl: string; explorerUrl: string; t: Tables; stop(): Promise<void> }`; `addInsightsTables(admin: pg.Pool): Promise<void>`; constants and row lists in `rows.ts` (below).

- [ ] **Step 1: Write the role SQL**

`manifests/arc-mainnet/k8s/explorer-role.sql`:

```sql
-- The explorer's database role: reads the worker's schema, owns its own.
-- Apply once as the database owner (arckive), after the explorer's Indexer has
-- created idx_arc_explorer, then give the role a password interactively:
--   kubectl exec -i pg-explorer-0 -- psql -U arckive -d explorer < manifests/arc-mainnet/k8s/explorer-role.sql
--   kubectl exec -it pg-explorer-0 -- psql -U arckive -d explorer -c '\password explorer'
-- and put that password in the explorer's DSN Secret (explorer-app.yaml).
-- Re-running it is harmless.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'explorer') THEN
    CREATE ROLE explorer LOGIN;
  END IF;
END
$$;

-- A slow query becomes an error page, never a hung request. The rollup job
-- raises it for its own transactions (SET LOCAL).
ALTER ROLE explorer SET statement_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS explorer AUTHORIZATION explorer;

GRANT USAGE ON SCHEMA idx_arc_explorer TO explorer;
GRANT SELECT ON ALL TABLES IN SCHEMA idx_arc_explorer TO explorer;
-- Tables the worker adds later (the _insights tables when lanes start): a
-- query through a partitioned parent needs the parent's privilege only.
ALTER DEFAULT PRIVILEGES FOR ROLE arckive IN SCHEMA idx_arc_explorer GRANT SELECT ON TABLES TO explorer;
```

- [ ] **Step 2: Write the fixture rows**

`packages/explorer/test/fixture/rows.ts`:

```ts
// Fixture rows for the explorer's tests and the browser smoke. Around one
// real Arc mainnet swap (the mockups' transaction) the rows cover a payment,
// a payment chain, a mint, a burn, a self-transfer, pool events and an
// address with more than one page of history across a UTC day boundary.

export const SCHEMA = 'idx_arc_explorer';
// small partitions, so keyset paging crosses partitions as in production
export const PARTITION_BLOCKS = 100n;
export const ZERO = '0x0000000000000000000000000000000000000000';
export const NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe';
export const POOLMANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';

const E18 = 10n ** 18n;
export const usdc = (whole: number, cents = 0): string => (BigInt(whole) * E18 + BigInt(cents) * 10n ** 16n).toString();
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const a = (tag: string): string => `0x${tag.repeat(40 / tag.length)}`;

// Mainnet tx 0x9a83…015a, block 24,787,775: 476.9325 USDC from the payer
// through 0x43d8…41d5 and the router into the PoolManager, which logs Swap at
// log 3 with amount0 −476.9325 (currency0 = address(0): native USDC, paid into
// the pool) and amount1 +13,763,833.33… of 0x6e71…b777.
export const SWAP_TX = '0x9a833894c76d093d304e8e907ae79a37ddaac7753fa9855df456643eba0f015a';
export const SWAP_POOL = '0x6c96ee62f2fcebe56264711c18d20e89bed338d4f055628313c9086f3add79e8';
export const SWAP_PAYER = '0x5e2928212630ccd57bc53f0df428fb678c0da2b7';
export const SWAP_HOP = '0x43d894e229a008c72e96872739719b9cfda941d5';
export const SWAP_TOKEN = '0x6e7155b7962844f2a0957d017416486f9efeb777';
export const SWAP_PAID = '476932500000000000000';
export const SWAP_RECEIVED = '13763833330793760056038261';
export const INIT_TX = '0x2cf901c8a420b3c34789a5f9e75e14d8f4a66051e83c24ad8749759bf4c79135';

export const PAY_TX = h(0x1001);
export const PAYER = a('88a5');
export const PAYEE = a('1c40');
export const CHAIN_TX = h(0x1002);
export const CHAIN = [a('c1'), a('c2'), a('c3'), a('c4')];
export const MINT_TX = h(0x1003);
export const BURN_TX = h(0x1004);
export const MINTEE = a('d00d');
export const SELF_TX = h(0x1005);
export const SELF = a('5e1f');
export const POOL_TX = h(0x1006);
export const LP = a('1b');
export const BUSY = a('b5');
export const CPS = [a('e1'), a('e2'), a('e3')];
export const UNSEEN = a('0f');

export interface Block { n: number; time: string }
export interface Transfer { n: number; li: number; tx: string; from: string; to: string; value: string }
export interface Swap { n: number; li: number; tx: string; pool: string; sender: string; amount0: string; amount1: string; fee: number }
export interface Init { n: number; li: number; tx: string; pool: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
export interface Modify { n: number; li: number; tx: string; pool: string; sender: string; tickLower: number; tickUpper: number; liquidityDelta: string }
export interface Donate { n: number; li: number; tx: string; pool: string; sender: string; amount0: string; amount1: string }
export interface Lane { n: number; li: number; lane: string; p: number | null; ruled: boolean; sentence: string }

// The busy address: 30 blocks, 40 apart (so 12 partitions), the first ten on
// 2026-10-07 and the rest on 2026-10-08 (UTC). Even i: in from CPS[i % 3];
// odd i: out to CPS[i % 3]; i = 15 a self-transfer; block i = 29 has a second
// row at log 1 (in).
export const BUSY_BASE = 24860000;
export const busyBlock = (i: number): number => BUSY_BASE + i * 40;
const busyTime = (i: number): string => new Date(Date.UTC(2026, 9, 7, 23, 59, 40) + i * 2000).toISOString();

export const BLOCKS: Block[] = [
  { n: 24787025, time: '2026-10-07T20:27:11Z' },
  { n: 24787775, time: '2026-10-07T20:33:32Z' },
  { n: 24787800, time: '2026-10-07T20:33:45Z' },
  { n: 24787801, time: '2026-10-07T20:33:45Z' },
  { n: 24787802, time: '2026-10-07T20:33:46Z' },
  { n: 24787803, time: '2026-10-07T20:33:46Z' },
  { n: 24787804, time: '2026-10-07T20:33:47Z' },
  { n: 24787850, time: '2026-10-07T20:34:10Z' },
  ...Array.from({ length: 30 }, (_, i) => ({ n: busyBlock(i), time: busyTime(i) })),
];

const busyRows: Transfer[] = Array.from({ length: 30 }, (_, i): Transfer => {
  const tx = h(0x2000 + i);
  if (i === 15) return { n: busyBlock(i), li: 0, tx, from: BUSY, to: BUSY, value: usdc(16) };
  const cp = CPS[i % 3]!;
  return i % 2 === 0
    ? { n: busyBlock(i), li: 0, tx, from: cp, to: BUSY, value: usdc(1 + i, 25) }
    : { n: busyBlock(i), li: 0, tx, from: BUSY, to: cp, value: usdc(1 + i) };
});
busyRows.push({ n: busyBlock(29), li: 1, tx: h(0x2100), from: CPS[0]!, to: BUSY, value: usdc(0, 1) });
export const BUSY_ROWS: readonly Transfer[] = busyRows;

export const TRANSFERS: Transfer[] = [
  { n: 24787775, li: 1, tx: SWAP_TX, from: SWAP_PAYER, to: SWAP_HOP, value: SWAP_PAID },
  { n: 24787775, li: 2, tx: SWAP_TX, from: SWAP_HOP, to: ROUTER, value: SWAP_PAID },
  { n: 24787775, li: 4, tx: SWAP_TX, from: ROUTER, to: POOLMANAGER, value: SWAP_PAID },
  { n: 24787800, li: 0, tx: PAY_TX, from: PAYER, to: PAYEE, value: usdc(311, 55) },
  { n: 24787801, li: 0, tx: CHAIN_TX, from: CHAIN[0]!, to: CHAIN[1]!, value: usdc(50) },
  { n: 24787801, li: 1, tx: CHAIN_TX, from: CHAIN[1]!, to: CHAIN[2]!, value: usdc(50) },
  { n: 24787801, li: 2, tx: CHAIN_TX, from: CHAIN[2]!, to: CHAIN[3]!, value: usdc(50) },
  { n: 24787802, li: 0, tx: MINT_TX, from: ZERO, to: MINTEE, value: usdc(10000) },
  { n: 24787803, li: 0, tx: BURN_TX, from: MINTEE, to: ZERO, value: usdc(5) },
  { n: 24787804, li: 0, tx: SELF_TX, from: SELF, to: SELF, value: usdc(1) },
  ...BUSY_ROWS,
];

export const INITS: Init[] = [
  { n: 24787025, li: 3, tx: INIT_TX, pool: SWAP_POOL, currency0: ZERO, currency1: SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: ZERO },
];

export const SWAPS: Swap[] = [
  { n: 24787775, li: 3, tx: SWAP_TX, pool: SWAP_POOL, sender: ROUTER, amount0: `-${SWAP_PAID}`, amount1: SWAP_RECEIVED, fee: 2500 },
];

export const MODIFIES: Modify[] = [
  { n: 24787850, li: 0, tx: POOL_TX, pool: SWAP_POOL, sender: LP, tickLower: -600, tickUpper: 600, liquidityDelta: '1000000000000' },
];

export const DONATES: Donate[] = [
  { n: 24787850, li: 1, tx: POOL_TX, pool: SWAP_POOL, sender: LP, amount0: usdc(1), amount1: '0' },
];

const SWAP_SENTENCE = 'USDC moved from a wallet to a contract, amount 100 to 1,000 USDC. In the same transaction: tokens were swapped on an exchange.';

// Lanes up to INSIGHTS_CURSOR: the swap (model), the payment (model), the
// mint (ruled), busy rows i < 20 alternating payment / signed payment. The
// chain, burn, self-transfer and pool rows sit inside the read range with no
// lane; busy rows i >= 20 sit above the cursor (not read yet); the Initialize
// is older than the first lane.
export const LANES: Lane[] = [
  ...[1, 2, 3, 4].map((li): Lane => ({ n: 24787775, li, lane: 'swap', p: 0.91, ruled: false, sentence: SWAP_SENTENCE })),
  { n: 24787800, li: 0, lane: 'payment', p: 0.88, ruled: false, sentence: 'USDC moved from a wallet to a wallet, amount 100 to 1,000 USDC.' },
  { n: 24787802, li: 0, lane: 'issuance', p: null, ruled: true, sentence: 'USDC was minted, amount over 1,000 USDC.' },
  ...BUSY_ROWS.filter((r) => r.n < busyBlock(20)).map((r, i): Lane => ({
    n: r.n, li: r.li, lane: i % 2 ? 'signed_payment' : 'payment', p: 0.8, ruled: false, sentence: `busy movement ${i}`,
  })),
];

export const CURSOR = busyBlock(29);
export const INSIGHTS_CURSOR = busyBlock(19);
export const FIRST_LANE_BLOCK = 24787775;
```

- [ ] **Step 3: Write the fixture database**

`packages/explorer/test/fixture/db.ts`:

```ts
// A PostgreSQL 17 with the explorer's Indexer schema built by core's DDL (the
// statements the worker's bootstrap runs; the worker itself is not imported,
// to keep the dependency direction explorer → core), the fixture rows, and
// the explorer role from the real explorer-role.sql. Relative imports carry
// .ts: smoke/serve.ts runs this file under Node's type stripping.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  buildControlTables, buildEventTable, buildInsightsTables, extractEventDefs, partitionDdl, type EventDef,
} from '@arckive/core';
import * as R from './rows.ts';

const TRANSFER_ABI = [
  { type: 'event', name: 'Transfer', inputs: [
    { name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false }] },
];
const POOL_ABI = [
  { type: 'event', name: 'Initialize', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true }, { name: 'fee', type: 'uint24', indexed: false },
    { name: 'tickSpacing', type: 'int24', indexed: false }, { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'tick', type: 'int24', indexed: false }] },
  { type: 'event', name: 'ModifyLiquidity', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'tickLower', type: 'int24', indexed: false }, { name: 'tickUpper', type: 'int24', indexed: false },
    { name: 'liquidityDelta', type: 'int256', indexed: false }, { name: 'salt', type: 'bytes32', indexed: false }] },
  { type: 'event', name: 'Swap', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'amount0', type: 'int128', indexed: false }, { name: 'amount1', type: 'int128', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false }, { name: 'fee', type: 'uint24', indexed: false }] },
  { type: 'event', name: 'Donate', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'sender', type: 'address', indexed: true },
    { name: 'amount0', type: 'uint256', indexed: false }, { name: 'amount1', type: 'uint256', indexed: false }] },
];

export const DEFS: EventDef[] = [
  ...extractEventDefs('usdc', R.NATIVE_USDC, TRANSFER_ABI),
  ...extractEventDefs('poolmanager', R.POOLMANAGER, POOL_ABI),
];
const ROLE_SQL = readFileSync(new URL('../../../../manifests/arc-mainnet/k8s/explorer-role.sql', import.meta.url), 'utf8');
const q = (id: string): string => `"${id}"`;
const S = q(R.SCHEMA);
const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');

export interface TestTables {
  schema: string; usdc: string; blocks: string; addresses: string; cursor: string; insights: string;
  insightsCursor: string; insightsFull: string; swap: string; initialize: string; modifyLiquidity: string; donate: string;
  names: { usdc: string; swap: string; initialize: string; modifyLiquidity: string; donate: string };
}

export interface TestDb {
  admin: pg.Pool;
  explorer: pg.Pool;
  adminUrl: string;
  explorerUrl: string;
  t: TestTables;
  stop(): Promise<void>;
}

function testTables(): TestTables {
  const s = (t: string): string => `${S}.${q(t)}`;
  const names = { usdc: 'usdc_transfer', swap: 'poolmanager_swap', initialize: 'poolmanager_initialize', modifyLiquidity: 'poolmanager_modify_liquidity', donate: 'poolmanager_donate' };
  return {
    schema: R.SCHEMA, usdc: s(names.usdc), blocks: s('_blocks'), addresses: s('_addresses'), cursor: s('_cursor'),
    insights: s('_insights'), insightsCursor: s('_insights_cursor'), insightsFull: s('_insights_full'),
    swap: s(names.swap), initialize: s(names.initialize), modifyLiquidity: s(names.modifyLiquidity), donate: s(names.donate), names,
  };
}

async function partitions(admin: pg.Pool, tables: string[], blocks: number[]): Promise<void> {
  const ns = [...new Set(blocks.map((n) => BigInt(n) / R.PARTITION_BLOCKS))];
  for (const table of tables) for (const n of ns) await admin.query(partitionDdl(R.SCHEMA, table, n, R.PARTITION_BLOCKS));
}

export async function addInsightsTables(admin: pg.Pool): Promise<void> {
  for (const s of buildInsightsTables(R.SCHEMA)) await admin.query(s);
  await partitions(admin, ['_insights'], R.BLOCKS.map((b) => b.n));
}

async function loadLanes(admin: pg.Pool): Promise<void> {
  for (const l of R.LANES) {
    const s = await admin.query<{ id: number }>(
      `INSERT INTO ${S}._sentences (sentence, model) VALUES ($1, $2) ON CONFLICT (sentence, model) DO UPDATE SET sentence = excluded.sentence RETURNING id`,
      [l.sentence, l.ruled ? '' : 'laya'],
    );
    const lab = await admin.query<{ id: number }>(
      `INSERT INTO ${S}._labels (lane, lane_p, ruled, protocol, facts, sentence_id) VALUES ($1, $2, $3, NULL, '{}', $4)
       ON CONFLICT (lane, lane_p, ruled, protocol, facts, sentence_id) DO UPDATE SET lane = excluded.lane RETURNING id`,
      [l.lane, l.p, l.ruled, s.rows[0]!.id],
    );
    await admin.query(`INSERT INTO ${S}._insights (block_number, log_index, lane, label_id) VALUES ($1, $2, $3, $4)`, [l.n, l.li, l.lane, lab.rows[0]!.id]);
  }
  await admin.query(`INSERT INTO ${S}._insights_cursor (id, last_block) VALUES (1, $1)`, [R.INSIGHTS_CURSOR]);
}

async function loadRows(admin: pg.Pool): Promise<void> {
  const addresses = [...new Set([
    ...R.TRANSFERS.flatMap((t) => [t.from, t.to]), ...R.SWAPS.map((s) => s.sender),
    ...R.INITS.flatMap((i) => [i.currency0, i.currency1, i.hooks]), ...R.MODIFIES.map((m) => m.sender), ...R.DONATES.map((d) => d.sender),
  ])];
  const id = new Map<string, number>();
  for (const addr of addresses) {
    const r = await admin.query<{ id: number }>(`INSERT INTO ${S}._addresses (address) VALUES ($1) RETURNING id`, [bytes(addr)]);
    id.set(addr, r.rows[0]!.id);
  }
  const ref = (addr: string): number => id.get(addr)!;
  for (const b of R.BLOCKS) {
    await admin.query(`INSERT INTO ${S}._blocks (block_number, block_hash, block_time) VALUES ($1, $2, $3)`, [b.n, bytes(`0x${b.n.toString(16).padStart(64, 'a')}`), b.time]);
  }
  for (const t of R.TRANSFERS) {
    await admin.query(`INSERT INTO ${S}.usdc_transfer (block_number, tx_hash, log_index, from_id, to_id, value) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.n, bytes(t.tx), t.li, ref(t.from), ref(t.to), t.value]);
  }
  for (const i of R.INITS) {
    await admin.query(`INSERT INTO ${S}.poolmanager_initialize (block_number, tx_hash, log_index, id, currency0_id, currency1_id, fee, tick_spacing, hooks_id, sqrt_price_x96, tick)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [i.n, bytes(i.tx), i.li, bytes(i.pool), ref(i.currency0), ref(i.currency1), i.fee, i.tickSpacing, ref(i.hooks), '29869335453848447162871957180171', 118651]);
  }
  for (const s of R.SWAPS) {
    await admin.query(`INSERT INTO ${S}.poolmanager_swap (block_number, tx_hash, log_index, id, sender_id, amount0, amount1, sqrt_price_x96, liquidity, tick, fee)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [s.n, bytes(s.tx), s.li, bytes(s.pool), ref(s.sender), s.amount0, s.amount1, '13271096871842896174976915886610', '2639229179487355546693978', 102425, s.fee]);
  }
  for (const m of R.MODIFIES) {
    await admin.query(`INSERT INTO ${S}.poolmanager_modify_liquidity (block_number, tx_hash, log_index, id, sender_id, tick_lower, tick_upper, liquidity_delta, salt)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.n, bytes(m.tx), m.li, bytes(m.pool), ref(m.sender), m.tickLower, m.tickUpper, m.liquidityDelta, bytes(`0x${'0'.repeat(64)}`)]);
  }
  for (const d of R.DONATES) {
    await admin.query(`INSERT INTO ${S}.poolmanager_donate (block_number, tx_hash, log_index, id, sender_id, amount0, amount1) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [d.n, bytes(d.tx), d.li, bytes(d.pool), ref(d.sender), d.amount0, d.amount1]);
  }
  await admin.query(`INSERT INTO ${S}._cursor (id, last_block) VALUES (1, $1)`, [R.CURSOR]);
}

export async function startDb(opts: { insights?: boolean } = {}): Promise<TestDb> {
  // the worker's role is the database owner, as in manifests/arc-mainnet/k8s/postgres.yaml
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withUsername('arckive').withPassword('arckive').withDatabase('explorer').start();
  const adminUrl = container.getConnectionUri();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  for (const s of buildControlTables(R.SCHEMA)) await admin.query(s);
  for (const def of DEFS) for (const s of buildEventTable(R.SCHEMA, def, { addressIndexes: true }).statements) await admin.query(s);
  await partitions(admin, [...DEFS.map((d) => d.tableName), '_blocks'], R.BLOCKS.map((b) => b.n));
  await loadRows(admin);
  if (opts.insights !== false) {
    await addInsightsTables(admin);
    await loadLanes(admin);
  }
  await admin.query(ROLE_SQL);
  await admin.query(`ALTER ROLE explorer PASSWORD 'explorer'`);
  const u = new URL(adminUrl);
  u.username = 'explorer';
  u.password = 'explorer';
  const explorerUrl = u.toString();
  const explorer = new pg.Pool({ connectionString: explorerUrl, max: 10 });
  return {
    admin, explorer, adminUrl, explorerUrl, t: testTables(),
    async stop() {
      await explorer.end();
      await admin.end();
      await container.stop();
    },
  };
}

export const ROLE = ROLE_SQL;
```

- [ ] **Step 4: Write the failing database tests**

`packages/explorer/test/db.test.ts`:

```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE, addInsightsTables, startDb, type TestDb } from './fixture/db.ts';
import { tables } from '../lib/db.js';
import { SchemaError, checkSchema, hasInsights } from '../lib/schema.js';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';

const cfg = { schema: 'idx_arc_explorer', usdcTable: 'usdc_transfer', poolPrefix: 'poolmanager_' };

describe('explorer database role (insights on)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db?.stop(); });

  it('names the same tables as the fixture', () => {
    expect(tables(cfg)).toEqual(db.t);
  });

  it("reads the worker's schema and cannot write it", async () => {
    const r = await db.explorer.query(`SELECT count(*)::int AS n FROM ${db.t.usdc}`);
    expect(r.rows[0].n).toBeGreaterThan(40);
    await expect(db.explorer.query(`INSERT INTO ${db.t.cursor} (id, last_block) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET last_block = 1`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(db.explorer.query(`CREATE TABLE ${db.t.schema}.x (a int)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('runs with a 5 s statement timeout', async () => {
    const r = await db.explorer.query('SHOW statement_timeout');
    expect(r.rows[0].statement_timeout).toBe('5s');
  });

  it('applies the role SQL again without error', async () => {
    await expect(db.admin.query(ROLE)).resolves.toBeDefined();
  });

  it('accepts the schema and sees lanes', async () => {
    await expect(checkSchema(db.explorer, db.t)).resolves.toBeUndefined();
    expect(await hasInsights(db.explorer, db.t)).toBe(true);
  });

  it('creates its own tables in schema explorer, twice', async () => {
    await ensureExplorerSchema(db.explorer);
    await ensureExplorerSchema(db.explorer);
    const r = await db.explorer.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'explorer' ORDER BY 1`);
    expect(r.rows.map((x) => x.table_name)).toEqual(['address_daily', 'rollup_cursor', 'tokens']);
  });

  it('refuses a schema that lacks a column, naming it', async () => {
    await db.admin.query(`CREATE SCHEMA idx_broken`);
    await db.admin.query(`CREATE TABLE idx_broken.usdc_transfer (block_number bigint, tx_hash bytea, log_index int, from_id int, to_id int)`);
    const broken = tables({ ...cfg, schema: 'idx_broken' });
    await expect(checkSchema(db.admin, broken)).rejects.toThrow(SchemaError);
    await expect(checkSchema(db.admin, broken)).rejects.toThrow(/usdc_transfer\.value/);
    await expect(checkSchema(db.admin, broken)).rejects.toThrow(/poolmanager_swap\b/);
  });

  it('says what to do when schema explorer is missing', async () => {
    await db.admin.query('ALTER SCHEMA explorer RENAME TO explorer_away');
    try {
      await expect(ensureExplorerSchema(db.explorer)).rejects.toThrow(/explorer-role\.sql/);
    } finally {
      await db.admin.query('ALTER SCHEMA explorer_away RENAME TO explorer');
    }
  });
});

describe('explorer database role (lanes switched on later)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb({ insights: false }); });
  afterAll(async () => { await db?.stop(); });

  it('has no lanes at first, and reads the lane tables the worker adds later', async () => {
    expect(await hasInsights(db.explorer, db.t)).toBe(false);
    await addInsightsTables(db.admin);
    expect(await hasInsights(db.explorer, db.t)).toBe(true);
    await expect(db.explorer.query(`SELECT count(*) FROM ${db.t.insightsFull}`)).resolves.toBeDefined();
  });

  it('connects with the DSN shape the Secret holds', async () => {
    const c = new pg.Client({ connectionString: db.explorerUrl });
    await c.connect();
    expect((await c.query('SELECT current_user AS u')).rows[0].u).toBe('explorer');
    await c.end();
  });
});
```

- [ ] **Step 5: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/db.test.ts`
Expected: FAIL — `../lib/db.js` not found. (Docker must be running.)

- [ ] **Step 6: Implement `lib/db.ts`, `lib/schema.ts`, `lib/explorer-schema.ts`**

`packages/explorer/lib/db.ts`:

```ts
import pg from 'pg';
import type { Config } from './config.js';

export const q = (id: string): string => `"${id}"`;

// pg returns bigint and numeric columns as strings, which is what amounts
// need. The role's 5 s statement_timeout (explorer-role.sql) bounds every query.
export function createPool(cfg: Pick<Config, 'databaseUrl'>): pg.Pool {
  return new pg.Pool({ connectionString: cfg.databaseUrl, max: 10, application_name: 'arckive-explorer' });
}

export interface Tables {
  schema: string;
  usdc: string;
  blocks: string;
  addresses: string;
  cursor: string;
  insights: string;
  insightsCursor: string;
  insightsFull: string;
  swap: string;
  initialize: string;
  modifyLiquidity: string;
  donate: string;
  names: { usdc: string; swap: string; initialize: string; modifyLiquidity: string; donate: string };
}

// Quoted, schema-qualified names of the worker's tables; `names` holds the
// bare table names the start-up check looks for.
export function tables(cfg: Pick<Config, 'schema' | 'usdcTable' | 'poolPrefix'>): Tables {
  const s = (t: string): string => `${q(cfg.schema)}.${q(t)}`;
  const names = {
    usdc: cfg.usdcTable,
    swap: `${cfg.poolPrefix}swap`,
    initialize: `${cfg.poolPrefix}initialize`,
    modifyLiquidity: `${cfg.poolPrefix}modify_liquidity`,
    donate: `${cfg.poolPrefix}donate`,
  };
  return {
    schema: cfg.schema,
    usdc: s(names.usdc),
    blocks: s('_blocks'),
    addresses: s('_addresses'),
    cursor: s('_cursor'),
    insights: s('_insights'),
    insightsCursor: s('_insights_cursor'),
    insightsFull: s('_insights_full'),
    swap: s(names.swap),
    initialize: s(names.initialize),
    modifyLiquidity: s(names.modifyLiquidity),
    donate: s(names.donate),
    names,
  };
}

export const hexToBytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');
export const bytesToHex = (b: Buffer): string => `0x${b.toString('hex')}`;
```

`packages/explorer/lib/schema.ts`:

```ts
import type pg from 'pg';
import type { Tables } from './db.js';

export class SchemaError extends Error {}

function required(t: Tables): Record<string, string[]> {
  return {
    [t.names.usdc]: ['block_number', 'tx_hash', 'log_index', 'from_id', 'to_id', 'value'],
    _blocks: ['block_number', 'block_time', '_ingested_at'],
    _addresses: ['id', 'address'],
    _cursor: ['last_block'],
    [t.names.swap]: ['block_number', 'tx_hash', 'log_index', 'id', 'sender_id', 'amount0', 'amount1', 'fee'],
    [t.names.initialize]: ['block_number', 'tx_hash', 'log_index', 'id', 'currency0_id', 'currency1_id', 'fee', 'tick_spacing', 'hooks_id'],
    [t.names.modifyLiquidity]: ['block_number', 'tx_hash', 'log_index', 'id', 'sender_id', 'tick_lower', 'tick_upper', 'liquidity_delta'],
    [t.names.donate]: ['block_number', 'tx_hash', 'log_index', 'id', 'sender_id', 'amount0', 'amount1'],
  };
}

const INSIGHTS: Record<string, string[]> = {
  _insights: ['block_number', 'log_index', 'lane', 'label_id'],
  _insights_cursor: ['last_block'],
  _insights_full: ['block_number', 'log_index', 'lane', 'lane_p', 'ruled', 'sentence'],
};

async function columns(pool: pg.Pool, schema: string): Promise<Map<string, Set<string>>> {
  const r = await pool.query<{ table_name: string; column_name: string }>(
    'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1',
    [schema],
  );
  const out = new Map<string, Set<string>>();
  for (const row of r.rows) {
    if (!out.has(row.table_name)) out.set(row.table_name, new Set());
    out.get(row.table_name)!.add(row.column_name);
  }
  return out;
}

function gaps(have: Map<string, Set<string>>, want: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(want)) {
    const got = have.get(table);
    if (!got) out.push(table);
    else for (const c of cols) if (!got.has(c)) out.push(`${table}.${c}`);
  }
  return out;
}

// The tables and columns the explorer reads. A schema from another layout or
// a renamed contract stops the process here with the list, instead of a 500
// on the first page that needs them.
export async function checkSchema(pool: pg.Pool, t: Tables): Promise<void> {
  const missing = gaps(await columns(pool, t.schema), required(t));
  if (missing.length) {
    throw new SchemaError(
      `schema ${t.schema} lacks ${missing.join(', ')}; is the explorer's Indexer (manifests/arc-mainnet/k8s/explorer.yaml) running, and was explorer-role.sql applied after it?`,
    );
  }
}

// Lanes exist once the Indexer's insights have run; until then the explorer
// shows rows without lanes and never names the _insights tables in a query.
export async function hasInsights(pool: pg.Pool, t: Tables): Promise<boolean> {
  return gaps(await columns(pool, t.schema), INSIGHTS).length === 0;
}
```

`packages/explorer/lib/explorer-schema.ts`:

```ts
import type pg from 'pg';
import { SchemaError } from './schema.js';

// The explorer's own tables, in schema `explorer` (created with the role by
// explorer-role.sql, owned by it). IF NOT EXISTS: there are no migrations yet.
const STATEMENTS = [
  // USDC received and sent per address per UTC day: an address page's totals
  // and chart over the whole history, never a scan of its transfers.
  `CREATE TABLE IF NOT EXISTS explorer.address_daily (
  address_id integer NOT NULL,
  day date NOT NULL,
  in_value numeric NOT NULL DEFAULT 0,
  out_value numeric NOT NULL DEFAULT 0,
  in_count integer NOT NULL DEFAULT 0,
  out_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (address_id, day)
)`,
  // the last block folded into address_daily
  `CREATE TABLE IF NOT EXISTS explorer.rollup_cursor (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  block_number bigint NOT NULL
)`,
  // pool currencies' symbol() / decimals(), read once; nulls when the token answers neither
  `CREATE TABLE IF NOT EXISTS explorer.tokens (
  address bytea PRIMARY KEY,
  symbol text,
  decimals smallint,
  read_at timestamptz NOT NULL DEFAULT now()
)`,
];

export async function ensureExplorerSchema(pool: pg.Pool): Promise<void> {
  // CREATE SCHEMA needs CREATE on the database, which the role does not have
  const r = await pool.query<{ ok: boolean }>(`SELECT to_regnamespace('explorer') IS NOT NULL AS ok`);
  if (!r.rows[0]!.ok) throw new SchemaError('schema explorer is missing; apply manifests/arc-mainnet/k8s/explorer-role.sql');
  for (const s of STATEMENTS) await pool.query(s);
}
```

- [ ] **Step 7: Run the tests**

Run: `corepack pnpm --filter @arckive/explorer test -- test/db.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 8: Lint and commit**

```bash
corepack pnpm lint
git add manifests/arc-mainnet/k8s/explorer-role.sql packages/explorer
git commit -m "feat(explorer): read-only role, start-up schema check and the explorer's own tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---
### Task 4: The rollup job

**Files:**
- Create: `packages/explorer/lib/log.ts`, `packages/explorer/lib/rollup.ts`
- Test: `packages/explorer/test/rollup.test.ts`

**Interfaces:**
- Consumes: `Tables` (Task 3), `ensureExplorerSchema` (Task 3), fixture `startDb` (Task 3).
- Produces:
  - `log.ts`: `type Logger = pino.Logger`, `log: Logger`, `errText(err: unknown): string`.
  - `rollup.ts`: `ROLLUP_LOCK: number`, `MAX_SPAN: bigint`, `type StepResult = 'more' | 'idle' | 'locked'`, `interface RollupOptions { maxSpan?: bigint; beforeCommit?: () => Promise<void> }`, `class Rollup { constructor(pool: pg.Pool, t: Tables, opts?: RollupOptions); readonly span: bigint; step(): Promise<StepResult>; rolledTo(): Promise<number | null>; start(log: Logger): () => void }`.

- [ ] **Step 1: Write the failing test**

`packages/explorer/test/rollup.test.ts`:

```ts
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import { BUSY, SELF } from './fixture/rows.ts';
import { tables } from '../lib/db.js';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';
import { ROLLUP_LOCK, Rollup } from '../lib/rollup.js';

const T = tables({ schema: 'idx_arc_explorer', usdcTable: 'usdc_transfer', poolPrefix: 'poolmanager_' });

// The same sums straight from the transfers: what address_daily must equal.
const DIRECT = `
SELECT address_id, day::text AS day, sum(in_value)::text AS in_value, sum(out_value)::text AS out_value,
       sum(in_count)::int AS in_count, sum(out_count)::int AS out_count
FROM (
  SELECT t.to_id AS address_id, (b.block_time AT TIME ZONE 'UTC')::date AS day, t.value AS in_value, 0::numeric AS out_value, 1 AS in_count, 0 AS out_count
  FROM ${T.usdc} t JOIN ${T.blocks} b ON b.block_number = t.block_number
  UNION ALL
  SELECT t.from_id, (b.block_time AT TIME ZONE 'UTC')::date, 0, t.value, 0, 1
  FROM ${T.usdc} t JOIN ${T.blocks} b ON b.block_number = t.block_number
) m GROUP BY 1, 2 ORDER BY 1, 2`;
const ROLLED = `SELECT address_id, day::text AS day, in_value::text AS in_value, out_value::text AS out_value, in_count, out_count
FROM explorer.address_daily ORDER BY 1, 2`;

async function drain(r: Rollup): Promise<number> {
  let steps = 0;
  for (;;) {
    steps++;
    if ((await r.step()) !== 'more') return steps;
  }
}

describe('rollup', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb();
    await ensureExplorerSchema(db.explorer);
  });
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    await db.admin.query('TRUNCATE explorer.address_daily, explorer.rollup_cursor');
  });

  it('folds every transfer into per-address per-day totals', async () => {
    const r = new Rollup(db.explorer, T);
    // 50,000-block ranges: the fixture's first rows, then the busy blocks
    expect(await drain(r)).toBe(2);
    expect((await db.explorer.query(ROLLED)).rows).toEqual((await db.explorer.query(DIRECT)).rows);
    expect(await r.rolledTo()).toBe(24861160);
  });

  it('gets the same totals folding in small uneven ranges', async () => {
    const r = new Rollup(db.explorer, T, { maxSpan: 37n });
    expect(await drain(r)).toBeGreaterThan(5);
    expect((await db.explorer.query(ROLLED)).rows).toEqual((await db.explorer.query(DIRECT)).rows);
  });

  it('folds nothing twice when a range dies before its commit', async () => {
    let n = 0;
    const crashing = new Rollup(db.explorer, T, {
      maxSpan: 200n,
      beforeCommit: async () => { if (++n === 2) throw new Error('killed'); },
    });
    expect(await crashing.step()).toBe('more');
    await expect(crashing.step()).rejects.toThrow('killed');
    await drain(new Rollup(db.explorer, T, { maxSpan: 200n }));
    expect((await db.explorer.query(ROLLED)).rows).toEqual((await db.explorer.query(DIRECT)).rows);
  });

  it('counts a self-transfer on both sides and splits days in UTC', async () => {
    await drain(new Rollup(db.explorer, T));
    const self = await db.explorer.query(
      `SELECT in_count, out_count FROM explorer.address_daily d JOIN ${T.addresses} a ON a.id = d.address_id WHERE a.address = $1`,
      [Buffer.from(SELF.slice(2), 'hex')],
    );
    expect(self.rows).toEqual([{ in_count: 1, out_count: 1 }]);
    const busy = await db.explorer.query(
      `SELECT day::text AS day FROM explorer.address_daily d JOIN ${T.addresses} a ON a.id = d.address_id WHERE a.address = $1 ORDER BY 1`,
      [Buffer.from(BUSY.slice(2), 'hex')],
    );
    expect(busy.rows.map((x) => x.day)).toEqual(['2026-10-07', '2026-10-08']);
  });

  it('skips a round while another replica holds the lock', async () => {
    const holder = new pg.Client({ connectionString: db.adminUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [ROLLUP_LOCK]);
    try {
      expect(await new Rollup(db.explorer, T).step()).toBe('locked');
    } finally {
      await holder.end();
    }
  });

  it('halves its span when a range outlives the statement timeout, and grows back', async () => {
    const r = new Rollup(db.explorer, T, {
      maxSpan: 4000n,
      beforeCommit: async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
    });
    await expect(r.step()).rejects.toThrow(/statement timeout/);
    expect(r.span).toBe(2000n);
    await expect(r.step()).rejects.toThrow(/statement timeout/);
    expect(r.span).toBe(1000n);
  });

  it('is idle once caught up with the worker', async () => {
    const r = new Rollup(db.explorer, T);
    await drain(r);
    expect(await r.step()).toBe('idle');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/rollup.test.ts`
Expected: FAIL — `../lib/rollup.js` not found.

- [ ] **Step 3: Implement `lib/log.ts` and `lib/rollup.ts`**

`packages/explorer/lib/log.ts`:

```ts
import pino from 'pino';

export type Logger = pino.Logger;

export const log: Logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', base: { app: 'arckive-explorer' } });

// pg's messages name relations and network addresses, never the DSN's password.
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

`packages/explorer/lib/rollup.ts`:

```ts
import type pg from 'pg';
import type { Tables } from './db.js';
import { errText, type Logger } from './log.js';

// One writer across replicas: a fold takes this transaction-scoped lock
// first, and a replica that cannot get it skips the round.
export const ROLLUP_LOCK = 0x61726b76; // "arkv"
// The largest range one transaction folds; the backfill goes through in these.
export const MAX_SPAN = 50_000n;
const MIN_SPAN = 500n;
const QUERY_CANCELED = '57014';
const IDLE_MS = 2000;

export type StepResult = 'more' | 'idle' | 'locked';

export interface RollupOptions {
  maxSpan?: bigint;
  // tests: runs after the fold and the cursor update, before COMMIT
  beforeCommit?: () => Promise<void>;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

// Received and sent per address per UTC day for (from, to]; a self-transfer
// counts on both sides. The upsert adds onto what earlier ranges folded.
function foldSql(t: Tables): string {
  const day = `(b.block_time AT TIME ZONE 'UTC')::date`;
  const from = `FROM ${t.usdc} t JOIN ${t.blocks} b ON b.block_number = t.block_number WHERE t.block_number > $1 AND t.block_number <= $2`;
  return `
INSERT INTO explorer.address_daily AS d (address_id, day, in_value, out_value, in_count, out_count)
SELECT address_id, day, sum(in_value), sum(out_value), sum(in_count)::int, sum(out_count)::int
FROM (
  SELECT t.to_id AS address_id, ${day} AS day, t.value AS in_value, 0::numeric AS out_value, 1 AS in_count, 0 AS out_count ${from}
  UNION ALL
  SELECT t.from_id, ${day}, 0, t.value, 0, 1 ${from}
) m
GROUP BY address_id, day
ON CONFLICT (address_id, day) DO UPDATE SET
  in_value = d.in_value + excluded.in_value,
  out_value = d.out_value + excluded.out_value,
  in_count = d.in_count + excluded.in_count,
  out_count = d.out_count + excluded.out_count`;
}

// Folds usdc_transfer into explorer.address_daily up to the worker's _cursor.
// Rows and rollup_cursor commit in one transaction, so a crash folds nothing
// twice. A range that outlives the statement timeout (the 2026-09-15 burst
// carries 90–180 transfers a block) halves the span; a success doubles it
// back toward the maximum.
export class Rollup {
  #span: bigint;
  readonly #maxSpan: bigint;
  readonly #sql: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly t: Tables,
    private readonly opts: RollupOptions = {},
  ) {
    this.#maxSpan = opts.maxSpan ?? MAX_SPAN;
    this.#span = this.#maxSpan;
    this.#sql = foldSql(t);
  }

  get span(): bigint {
    return this.#span;
  }

  async rolledTo(): Promise<number | null> {
    const r = await this.pool.query<{ n: string }>('SELECT block_number::text AS n FROM explorer.rollup_cursor WHERE id = 1');
    return r.rowCount ? Number(r.rows[0]!.n) : null;
  }

  async step(): Promise<StepResult> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [ROLLUP_LOCK]);
      if (!lock.rows[0]!.ok) {
        await c.query('ROLLBACK');
        return 'locked';
      }
      // a backfill range may need longer than the role's 5 s page budget
      await c.query("SET LOCAL statement_timeout = '120s'");
      const head = await c.query<{ n: string }>(`SELECT last_block::text AS n FROM ${this.t.cursor} WHERE id = 1`);
      if (!head.rowCount) {
        await c.query('ROLLBACK');
        return 'idle';
      }
      const cursor = BigInt(head.rows[0]!.n);
      const done = await c.query<{ n: string }>('SELECT block_number::text AS n FROM explorer.rollup_cursor WHERE id = 1');
      const from = done.rowCount ? BigInt(done.rows[0]!.n) : -1n;
      if (from >= cursor) {
        await c.query('ROLLBACK');
        return 'idle';
      }
      // Empty stretches (the chain's first weeks) cost one lookup, not a range each.
      const next = await c.query<{ n: string | null }>(
        `SELECT min(block_number)::text AS n FROM ${this.t.blocks} WHERE block_number > $1 AND block_number <= $2`,
        [from.toString(), cursor.toString()],
      );
      const first = next.rows[0]!.n === null ? null : BigInt(next.rows[0]!.n);
      const to = first === null ? cursor : min(cursor, first - 1n + this.#span);
      if (first !== null) await c.query(this.#sql, [from.toString(), to.toString()]);
      await c.query(
        `INSERT INTO explorer.rollup_cursor (id, block_number) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET block_number = excluded.block_number`,
        [to.toString()],
      );
      await this.opts.beforeCommit?.();
      await c.query('COMMIT');
      this.#span = min(this.#maxSpan, this.#span * 2n);
      return to < cursor ? 'more' : 'idle';
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === QUERY_CANCELED) {
        const floor = this.#maxSpan < MIN_SPAN ? 1n : MIN_SPAN;
        this.#span = max(floor, this.#span / 2n);
      }
      throw err;
    } finally {
      c.release();
    }
  }

  // Through the backfill range after range, then every 2 s on what is new.
  start(logger: Logger): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<void> => {
      let wait = IDLE_MS;
      try {
        if ((await this.step()) === 'more') wait = 0;
      } catch (err) {
        logger.warn({ err: errText(err), span: this.#span.toString() }, 'rollup range failed');
      }
      if (!stopped) timer = setTimeout(run, wait);
    };
    timer = setTimeout(run, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm --filter @arckive/explorer test -- test/rollup.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): fold USDC transfers into per-address daily totals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 5: Token metadata, transaction rows and lane state

**Files:**
- Create: `packages/explorer/lib/tokens.ts`, `lib/tx.ts`, `lib/lanewhy.ts`
- Test: `packages/explorer/test/tokens.test.ts`, `test/tx.test.ts`

**Interfaces:**
- Consumes: `Tables`, `hexToBytes`, `bytesToHex` (Task 3); `LaneState` (Task 2); fixture (Task 3).
- Produces:
  - `tokens.ts`: `interface TokenMeta { symbol: string | null; decimals: number | null }`, `type ReadResult = TokenMeta | 'unavailable'`, `interface TokenReader { read(address: string): Promise<ReadResult> }`, `classifyReadError(err: unknown): 'none' | 'unavailable'`, `sanitizeSymbol(s: unknown): string | null`, `rpcTokenReader(rpcUrl: string): TokenReader`, `class Tokens { constructor(pool: pg.Pool, reader: TokenReader); get(addresses: string[]): Promise<Record<string, TokenMeta>> }`.
  - `tx.ts`: `TxTransfer { li; from; to; value }`, `TxSwap { li; pool; sender; amount0; amount1; fee }`, `TxModify { li; pool; sender; tickLower; tickUpper; liquidityDelta }`, `TxDonate { li; pool; sender; amount0; amount1 }`, `TxInit { li; pool; currency0; currency1; fee; tickSpacing; hooks }`, `PoolInfo { id; currency0; currency1; fee; tickSpacing; hooks }`, `TxData { hash; block; time; transfers; swaps; modifies; donates; inits; pools: Record<string, PoolInfo> }` (all `li`/`fee`/`tick*` numbers, amounts integer strings, addresses and ids lowercase `0x…`), `loadTx(pool, t, hash): Promise<TxData | null>`, `interface InsightsInfo { on: boolean; firstBlock: number | null; firstTime: number | null }`, `loadInsightsInfo(pool, t, on: boolean): Promise<InsightsInfo>`, `laneOrder(tx: TxData): number[]`, `loadLane(pool, t, info: InsightsInfo, block: number, logIndices: number[]): Promise<LaneState>`.
  - `lanewhy.ts`: `laneWhy(lane: string, ruled: boolean): string`.

- [ ] **Step 1: Write the failing tests**

`packages/explorer/test/tokens.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, erc20Abi,
} from 'viem';
import { startDb, type TestDb } from './fixture/db.ts';
import { SWAP_TOKEN, ZERO } from './fixture/rows.ts';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';
import { Tokens, classifyReadError, sanitizeSymbol, type ReadResult, type TokenReader } from '../lib/tokens.js';

function fakeReader(answers: Record<string, ReadResult>): TokenReader & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async read(a) { calls.push(a); return answers[a] ?? { symbol: null, decimals: null }; } };
}

describe('classifyReadError', () => {
  const wrap = (cause: Error) => new ContractFunctionExecutionError(cause as never, { abi: erc20Abi, functionName: 'symbol' });
  it('reads a revert or empty answer as "not a token"', () => {
    expect(classifyReadError(wrap(new ContractFunctionZeroDataError({ functionName: 'symbol' })))).toBe('none');
    expect(classifyReadError(wrap(new ContractFunctionRevertedError({ abi: erc20Abi, functionName: 'symbol', message: 'execution reverted' })))).toBe('none');
  });
  it('reads a transport failure as "ask again later"', () => {
    expect(classifyReadError(wrap(new HttpRequestError({ url: 'https://rpc.example', status: 429 })))).toBe('unavailable');
  });
});

describe('sanitizeSymbol', () => {
  it('keeps printable ASCII, at most 16 characters', () => {
    expect(sanitizeSymbol('USDC')).toBe('USDC');
    expect(sanitizeSymbol('A\u0000B‮C')).toBe('ABC');
    expect(sanitizeSymbol('x'.repeat(40))).toBe('x'.repeat(16));
    expect(sanitizeSymbol('  ')).toBeNull();
    expect(sanitizeSymbol(42)).toBeNull();
  });
});

describe('Tokens', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb({ insights: false });
    await ensureExplorerSchema(db.explorer);
  });
  afterAll(async () => { await db?.stop(); });

  it('never reads address(0): in a v4 pool it is native USDC', async () => {
    const reader = fakeReader({});
    expect(await new Tokens(db.explorer, reader).get([ZERO])).toEqual({ [ZERO]: { symbol: 'USDC', decimals: 18 } });
    expect(reader.calls).toEqual([]);
  });

  it('reads a token once and keeps it', async () => {
    const reader = fakeReader({ [SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } });
    const tokens = new Tokens(db.explorer, reader);
    expect(await tokens.get([SWAP_TOKEN, SWAP_TOKEN])).toEqual({ [SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } });
    expect(await new Tokens(db.explorer, fakeReader({})).get([SWAP_TOKEN])).toEqual({ [SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } });
    expect(reader.calls).toEqual([SWAP_TOKEN]);
  });

  it('stores a token that answers neither as nulls', async () => {
    const odd = `0x${'7'.repeat(40)}`;
    await new Tokens(db.explorer, fakeReader({ [odd]: { symbol: null, decimals: null } })).get([odd]);
    const r = await db.explorer.query('SELECT symbol, decimals FROM explorer.tokens WHERE address = $1', [Buffer.from(odd.slice(2), 'hex')]);
    expect(r.rows).toEqual([{ symbol: null, decimals: null }]);
  });

  it('does not store a read the RPC could not answer', async () => {
    const down = `0x${'8'.repeat(40)}`;
    expect(await new Tokens(db.explorer, fakeReader({ [down]: 'unavailable' })).get([down])).toEqual({ [down]: { symbol: null, decimals: null } });
    const r = await db.explorer.query('SELECT 1 FROM explorer.tokens WHERE address = $1', [Buffer.from(down.slice(2), 'hex')]);
    expect(r.rowCount).toBe(0);
  });
});
```

`packages/explorer/test/tx.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { loadInsightsInfo, laneOrder, loadLane, loadTx, type InsightsInfo } from '../lib/tx.js';
import { laneWhy } from '../lib/lanewhy.js';

describe('transactions', () => {
  let db: TestDb;
  let info: InsightsInfo;
  beforeAll(async () => {
    db = await startDb();
    info = await loadInsightsInfo(db.explorer, db.t, true);
  });
  afterAll(async () => { await db?.stop(); });

  it('loads the mainnet swap with its pool', async () => {
    const tx = await loadTx(db.explorer, db.t, R.SWAP_TX);
    expect(tx).toEqual({
      hash: R.SWAP_TX,
      block: 24787775,
      time: Date.UTC(2026, 9, 7, 20, 33, 32) / 1000,
      transfers: [
        { li: 1, from: R.SWAP_PAYER, to: R.SWAP_HOP, value: R.SWAP_PAID },
        { li: 2, from: R.SWAP_HOP, to: R.ROUTER, value: R.SWAP_PAID },
        { li: 4, from: R.ROUTER, to: R.POOLMANAGER, value: R.SWAP_PAID },
      ],
      swaps: [{ li: 3, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: `-${R.SWAP_PAID}`, amount1: R.SWAP_RECEIVED, fee: 2500 }],
      modifies: [],
      donates: [],
      inits: [],
      pools: { [R.SWAP_POOL]: { id: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO } },
    });
  });

  it('loads pool-only transactions', async () => {
    const tx = await loadTx(db.explorer, db.t, R.POOL_TX);
    expect(tx?.transfers).toEqual([]);
    expect(tx?.modifies).toEqual([{ li: 0, pool: R.SWAP_POOL, sender: R.LP, tickLower: -600, tickUpper: 600, liquidityDelta: '1000000000000' }]);
    expect(tx?.donates).toEqual([{ li: 1, pool: R.SWAP_POOL, sender: R.LP, amount0: R.usdc(1), amount1: '0' }]);
    const init = await loadTx(db.explorer, db.t, R.INIT_TX);
    expect(init?.inits).toEqual([{ li: 3, pool: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO }]);
  });

  it('returns null for a hash Arckive has no event for', async () => {
    expect(await loadTx(db.explorer, db.t, `0x${'ab'.repeat(32)}`)).toBeNull();
  });

  it('orders transfers before pool events when picking the lane row', async () => {
    const tx = (await loadTx(db.explorer, db.t, R.SWAP_TX))!;
    expect(laneOrder(tx)).toEqual([1, 2, 4, 3]);
  });

  it('knows where lanes began', () => {
    expect(info).toEqual({ on: true, firstBlock: R.FIRST_LANE_BLOCK, firstTime: Date.UTC(2026, 9, 7, 20, 33, 32) / 1000 });
  });

  it('reads a model lane, a ruled lane, and the states without one', async () => {
    expect(await loadLane(db.explorer, db.t, info, 24787775, [1, 2, 4, 3])).toEqual({
      kind: 'read', lane: 'swap', p: 0.91, ruled: false,
      sentence: 'USDC moved from a wallet to a contract, amount 100 to 1,000 USDC. In the same transaction: tokens were swapped on an exchange.',
      why: 'Tokens were swapped on an exchange or traded on a marketplace.',
    });
    expect(await loadLane(db.explorer, db.t, info, 24787802, [0])).toMatchObject({ kind: 'read', lane: 'issuance', p: null, ruled: true });
    expect(await loadLane(db.explorer, db.t, info, 24787025, [3])).toEqual({ kind: 'before', since: info.firstTime });
    expect(await loadLane(db.explorer, db.t, info, 24787803, [0])).toEqual({ kind: 'none' });
    expect(await loadLane(db.explorer, db.t, info, R.busyBlock(25), [0])).toEqual({ kind: 'pending' });
    expect(await loadLane(db.explorer, db.t, { on: false, firstBlock: null, firstTime: null }, 24787775, [1])).toEqual({ kind: 'off' });
  });

  it('explains ruled and unsure lanes', () => {
    expect(laneWhy('issuance', true)).toMatch(/^Ruled: USDC was minted or burned/);
    expect(laneWhy('uncertain', false)).toMatch(/not sure enough/);
    expect(laneWhy('payment', false)).toBe('A plain direct transfer, with nothing else happening.');
  });
});

describe('transactions before lanes exist', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb({ insights: false }); });
  afterAll(async () => { await db?.stop(); });

  it('loads a transaction and reports lanes off without touching _insights', async () => {
    const info = await loadInsightsInfo(db.explorer, db.t, false);
    expect(info).toEqual({ on: false, firstBlock: null, firstTime: null });
    const tx = await loadTx(db.explorer, db.t, R.PAY_TX);
    expect(tx?.transfers).toEqual([{ li: 0, from: R.PAYER, to: R.PAYEE, value: R.usdc(311, 55) }]);
    expect(await loadLane(db.explorer, db.t, info, tx!.block, [0])).toEqual({ kind: 'off' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/tokens.test.ts test/tx.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `lib/tokens.ts`**

```ts
import type pg from 'pg';
import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, HttpRequestError, RpcRequestError, TimeoutError,
  createPublicClient, erc20Abi, http,
} from 'viem';
import { hexToBytes, bytesToHex } from './db.js';
import { ZERO_ADDRESS } from './format.js';

export interface TokenMeta {
  symbol: string | null;
  decimals: number | null;
}

export type ReadResult = TokenMeta | 'unavailable';

export interface TokenReader {
  read(address: string): Promise<ReadResult>;
}

// In a v4 pool, address(0) is the chain's native currency: on Arc, USDC with 18 decimals.
const NATIVE: TokenMeta = { symbol: 'USDC', decimals: 18 };

// Only a revert or an empty answer means "not a token"; a transport failure
// (a rate limit, a timeout) is asked again on a later page view, never stored.
export function classifyReadError(err: unknown): 'none' | 'unavailable' {
  if (!(err instanceof BaseError)) return 'none';
  if (err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) return 'none';
  if (err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError)) return 'unavailable';
  return 'none';
}

// A token names itself: printable ASCII only (no control or bidi characters), short.
export function sanitizeSymbol(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 16);
  return clean || null;
}

async function attempt<T>(f: () => Promise<T>): Promise<T | null | 'unavailable'> {
  try {
    return await f();
  } catch (err) {
    return classifyReadError(err) === 'unavailable' ? 'unavailable' : null;
  }
}

export function rpcTokenReader(rpcUrl: string): TokenReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 4000, retryCount: 1 }) });
  return {
    async read(a) {
      const address = a as `0x${string}`;
      const [symbol, decimals] = await Promise.all([
        attempt(() => client.readContract({ address, abi: erc20Abi, functionName: 'symbol' })),
        attempt(() => client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })),
      ]);
      if (symbol === 'unavailable' || decimals === 'unavailable') return 'unavailable';
      return { symbol: sanitizeSymbol(symbol), decimals: typeof decimals === 'number' && decimals <= 77 ? decimals : null };
    },
  };
}

// Pool currencies' symbol and decimals, read over ARC_RPC the first time a
// page needs them and kept in explorer.tokens.
export class Tokens {
  constructor(
    private readonly pool: pg.Pool,
    private readonly reader: TokenReader,
  ) {}

  async get(addresses: string[]): Promise<Record<string, TokenMeta>> {
    const out: Record<string, TokenMeta> = {};
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => {
      if (a === ZERO_ADDRESS) out[a] = NATIVE;
      return a !== ZERO_ADDRESS;
    });
    if (!wanted.length) return out;
    const known = await this.pool.query<{ address: Buffer; symbol: string | null; decimals: number | null }>(
      'SELECT address, symbol, decimals FROM explorer.tokens WHERE address = ANY($1::bytea[])',
      [wanted.map(hexToBytes)],
    );
    for (const r of known.rows) out[bytesToHex(r.address)] = { symbol: r.symbol, decimals: r.decimals };
    await Promise.all(
      wanted.filter((a) => !out[a]).map(async (a) => {
        const meta = await this.reader.read(a);
        if (meta === 'unavailable') {
          out[a] = { symbol: null, decimals: null };
          return;
        }
        out[a] = meta;
        await this.pool.query(
          'INSERT INTO explorer.tokens (address, symbol, decimals) VALUES ($1, $2, $3) ON CONFLICT (address) DO NOTHING',
          [hexToBytes(a), meta.symbol, meta.decimals],
        );
      }),
    );
    return out;
  }
}
```

- [ ] **Step 4: Implement `lib/lanewhy.ts` and `lib/tx.ts`**

`packages/explorer/lib/lanewhy.ts`:

```ts
import { LANES, UNCERTAIN_BELOW } from '@arckive/core';

// What a ruled lane was ruled by (core's insights rules), in the page's words.
const RULED: Readonly<Record<string, string>> = {
  issuance: 'Ruled: USDC was minted or burned — the zero address is a party.',
  spam: 'Ruled: less than a cent moved and nothing else happened.',
  uncertain: 'Ruled: the transfer gave too little to read.',
  no_transfer: 'Ruled: nothing was transferred in this transaction.',
};

export function laneWhy(lane: string, ruled: boolean): string {
  if (ruled) return RULED[lane] ?? 'Ruled by the transaction itself.';
  if (lane === 'uncertain') return `Laya was not sure enough to file it (below ${UNCERTAIN_BELOW}).`;
  const text = LANES[lane];
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : 'Laya filed it under this lane.';
}
```

`packages/explorer/lib/tx.ts`:

```ts
import type pg from 'pg';
import { bytesToHex, hexToBytes, type Tables } from './db.js';
import { laneWhy } from './lanewhy.js';
import type { LaneState } from './types.js';

export interface TxTransfer { li: number; from: string; to: string; value: string }
export interface TxSwap { li: number; pool: string; sender: string; amount0: string; amount1: string; fee: number }
export interface TxModify { li: number; pool: string; sender: string; tickLower: number; tickUpper: number; liquidityDelta: string }
export interface TxDonate { li: number; pool: string; sender: string; amount0: string; amount1: string }
export interface TxInit { li: number; pool: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
export interface PoolInfo { id: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }

export interface TxData {
  hash: string;
  block: number;
  time: number;
  transfers: TxTransfer[];
  swaps: TxSwap[];
  modifies: TxModify[];
  donates: TxDonate[];
  inits: TxInit[];
  pools: Record<string, PoolInfo>;
}

type Row = Record<string, unknown> & { b: string };

// Every indexed row sharing the hash, one query per table through its
// tx_hash index, then the block's time and the pools' Initialize rows.
export async function loadTx(pool: pg.Pool, t: Tables, hash: string): Promise<TxData | null> {
  const key = hexToBytes(hash);
  const [tr, sw, ml, dn, ini] = await Promise.all([
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, fa.address AS f, ta.address AS r, x.value::text AS v
       FROM ${t.usdc} x JOIN ${t.addresses} fa ON fa.id = x.from_id JOIN ${t.addresses} ta ON ta.id = x.to_id
       WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, a.address AS s, x.amount0::text AS a0, x.amount1::text AS a1, x.fee::int AS fee
       FROM ${t.swap} x JOIN ${t.addresses} a ON a.id = x.sender_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, a.address AS s, x.tick_lower::int AS lo, x.tick_upper::int AS hi, x.liquidity_delta::text AS d
       FROM ${t.modifyLiquidity} x JOIN ${t.addresses} a ON a.id = x.sender_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, a.address AS s, x.amount0::text AS a0, x.amount1::text AS a1
       FROM ${t.donate} x JOIN ${t.addresses} a ON a.id = x.sender_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
    pool.query<Row>(
      `SELECT x.block_number::text AS b, x.log_index AS li, x.id, c0.address AS c0, c1.address AS c1, x.fee::int AS fee, x.tick_spacing::int AS ts, h.address AS h
       FROM ${t.initialize} x JOIN ${t.addresses} c0 ON c0.id = x.currency0_id JOIN ${t.addresses} c1 ON c1.id = x.currency1_id
       JOIN ${t.addresses} h ON h.id = x.hooks_id WHERE x.tx_hash = $1 ORDER BY x.log_index`, [key]),
  ]);
  const any = [tr, sw, ml, dn, ini].find((r) => r.rowCount)?.rows[0];
  if (!any) return null;
  const block = Number(any.b);
  const hex = (v: unknown): string => bytesToHex(v as Buffer);
  const tx: TxData = {
    hash,
    block,
    time: 0,
    transfers: tr.rows.map((r) => ({ li: r['li'] as number, from: hex(r['f']), to: hex(r['r']), value: r['v'] as string })),
    swaps: sw.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), sender: hex(r['s']), amount0: r['a0'] as string, amount1: r['a1'] as string, fee: r['fee'] as number })),
    modifies: ml.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), sender: hex(r['s']), tickLower: r['lo'] as number, tickUpper: r['hi'] as number, liquidityDelta: r['d'] as string })),
    donates: dn.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), sender: hex(r['s']), amount0: r['a0'] as string, amount1: r['a1'] as string })),
    inits: ini.rows.map((r) => ({ li: r['li'] as number, pool: hex(r['id']), currency0: hex(r['c0']), currency1: hex(r['c1']), fee: r['fee'] as number, tickSpacing: r['ts'] as number, hooks: hex(r['h']) })),
    pools: {},
  };
  const ids = [...new Set([...tx.swaps, ...tx.modifies, ...tx.donates, ...tx.inits].map((e) => e.pool))];
  const [time, pools] = await Promise.all([
    pool.query<{ t: string }>(`SELECT extract(epoch from block_time)::bigint::text AS t FROM ${t.blocks} WHERE block_number = $1`, [block]),
    ids.length
      ? pool.query<Row>(
          `SELECT x.block_number::text AS b, x.id, c0.address AS c0, c1.address AS c1, x.fee::int AS fee, x.tick_spacing::int AS ts, h.address AS h
           FROM ${t.initialize} x JOIN ${t.addresses} c0 ON c0.id = x.currency0_id JOIN ${t.addresses} c1 ON c1.id = x.currency1_id
           JOIN ${t.addresses} h ON h.id = x.hooks_id WHERE x.id = ANY($1::bytea[])`, [ids.map(hexToBytes)])
      : Promise.resolve({ rows: [] as Row[] }),
  ]);
  tx.time = time.rowCount ? Number(time.rows[0]!.t) : 0;
  for (const r of pools.rows) {
    const id = hex(r['id']);
    tx.pools[id] = { id, currency0: hex(r['c0']), currency1: hex(r['c1']), fee: r['fee'] as number, tickSpacing: r['ts'] as number, hooks: hex(r['h']) };
  }
  return tx;
}

export interface InsightsInfo {
  on: boolean;
  firstBlock: number | null; // the first block with a lane: older transactions predate lanes
  firstTime: number | null;
}

export async function loadInsightsInfo(pool: pg.Pool, t: Tables, on: boolean): Promise<InsightsInfo> {
  if (!on) return { on, firstBlock: null, firstTime: null };
  const r = await pool.query<{ n: string; t: string }>(
    `SELECT b.block_number::text AS n, extract(epoch from b.block_time)::bigint::text AS t FROM ${t.blocks} b
     WHERE b.block_number = (SELECT min(block_number) FROM ${t.insights})`,
  );
  return r.rowCount ? { on, firstBlock: Number(r.rows[0]!.n), firstTime: Number(r.rows[0]!.t) } : { on, firstBlock: null, firstTime: null };
}

// The row whose lane the page shows: the first USDC movement, else the first pool event.
export function laneOrder(tx: TxData): number[] {
  const pools = [...tx.swaps, ...tx.modifies, ...tx.donates, ...tx.inits].map((e) => e.li).sort((a, b) => a - b);
  return [...tx.transfers.map((e) => e.li), ...pools];
}

export async function loadLane(pool: pg.Pool, t: Tables, info: InsightsInfo, block: number, logIndices: number[]): Promise<LaneState> {
  if (!info.on) return { kind: 'off' };
  const r = await pool.query<{ li: number; lane: string; p: number | null; ruled: boolean; sentence: string }>(
    `SELECT log_index AS li, lane, lane_p AS p, ruled, sentence FROM ${t.insightsFull} WHERE block_number = $1 AND log_index = ANY($2::int[])`,
    [block, logIndices],
  );
  if (r.rowCount) {
    const row = [...r.rows].sort((a, b) => logIndices.indexOf(a.li) - logIndices.indexOf(b.li))[0]!;
    const p = row.p === null ? null : Math.round(row.p * 100) / 100;
    return { kind: 'read', lane: row.lane, p, ruled: row.ruled, sentence: row.sentence, why: laneWhy(row.lane, row.ruled) };
  }
  if (info.firstBlock !== null && block < info.firstBlock) return { kind: 'before', since: info.firstTime! };
  const c = await pool.query<{ n: string }>(`SELECT last_block::text AS n FROM ${t.insightsCursor} WHERE id = 1`);
  const read = c.rowCount ? Number(c.rows[0]!.n) : null;
  return read === null || block > read ? { kind: 'pending' } : { kind: 'none' };
}
```

- [ ] **Step 5: Run the tests**

Run: `corepack pnpm --filter @arckive/explorer test -- test/tokens.test.ts test/tx.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): load a transaction's rows, pools, token metadata and lane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 6: Transaction sentences, swap box, events and facts

**Files:**
- Create: `packages/explorer/lib/txstory.ts`
- Test: `packages/explorer/test/txstory.test.ts`

**Interfaces:**
- Consumes: `TxData`, `TxTransfer`, `TxSwap`, `PoolInfo` (Task 5), `TokenMeta` (Task 5), `Part` (Task 2), format helpers (Task 2).
- Produces: `isChain(ts: TxTransfer[]): boolean`, `txHeadline(tx: TxData): Part[]`, `txPath(tx: TxData, tokens: Record<string, TokenMeta>): Part[]`, `interface SwapSide { amount: string; token: string; tokenAddress: string }`, `interface SwapView { li: number; pool: string; paid: SwapSide | null; received: SwapSide | null; fee: string; known: boolean }`, `swapView(s: TxSwap, pool: PoolInfo | undefined, tokens: Record<string, TokenMeta>): SwapView`, `interface FlowView { nodes: { role: string; address: string }[]; edges: { amount: string; li: number }[] }`, `flowView(ts: TxTransfer[]): FlowView | null`, `interface EventRow { li: number; kind: 'Transfer' | 'Swap' | 'Liquidity' | 'Donate' | 'Initialize'; parts: Part[]; amount: string | null }`, `eventRows(tx: TxData): EventRow[]`, `txFacts(tx: TxData): { protocol: string; pool: string | null; parties: string[] }`, `legsLabel(tx: TxData): string`, `tokenAddresses(tx: TxData): string[]`.

- [ ] **Step 1: Write the failing test**

`packages/explorer/test/txstory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as R from './fixture/rows.ts';
import type { TxData } from '../lib/tx.js';
import {
  eventRows, flowView, isChain, legsLabel, swapView, tokenAddresses, txFacts, txHeadline, txPath,
} from '../lib/txstory.js';

const POOL = { id: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO };
const base = (over: Partial<TxData>): TxData => ({
  hash: R.SWAP_TX, block: 24787775, time: Date.UTC(2026, 9, 7, 20, 33, 32) / 1000,
  transfers: [], swaps: [], modifies: [], donates: [], inits: [], pools: {}, ...over,
});
const SWAP: TxData = base({
  transfers: [
    { li: 1, from: R.SWAP_PAYER, to: R.SWAP_HOP, value: R.SWAP_PAID },
    { li: 2, from: R.SWAP_HOP, to: R.ROUTER, value: R.SWAP_PAID },
    { li: 4, from: R.ROUTER, to: R.POOLMANAGER, value: R.SWAP_PAID },
  ],
  swaps: [{ li: 3, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: `-${R.SWAP_PAID}`, amount1: R.SWAP_RECEIVED, fee: 2500 }],
  pools: { [R.SWAP_POOL]: POOL },
});
const TOKENS = { [R.SWAP_TOKEN]: { symbol: 'PUMP', decimals: 18 } };
const t = (li: number, from: string, to: string, whole: number) => ({ li, from, to, value: R.usdc(whole) });

describe('the known mainnet swap', () => {
  it('reads negative deltas as paid into the pool (mainnet tx 0x9a83…015a)', () => {
    expect(swapView(SWAP.swaps[0]!, POOL, TOKENS)).toEqual({
      li: 3, pool: R.SWAP_POOL, fee: '0.25%', known: true,
      paid: { amount: '476.93', token: 'USDC (native)', tokenAddress: R.ZERO },
      received: { amount: '13,763,833.33', token: 'PUMP', tokenAddress: R.SWAP_TOKEN },
    });
  });

  it('writes its headline and path', () => {
    expect(txHeadline(SWAP)).toEqual([{ addr: R.SWAP_PAYER }, ' swapped ', { b: '476.93 USDC' }, ' on Uniswap v4.']);
    expect(txPath(SWAP, TOKENS)).toEqual([
      'The USDC went from ', { addr: R.SWAP_PAYER }, ' through ', { addr: R.SWAP_HOP }, ' and ', { addr: R.ROUTER },
      ' to ', { addr: R.POOLMANAGER }, ' in block ', { b: '24,787,775' }, ' at 20:33:32 UTC.',
      ' It came back as ', { b: '13,763,833.33' }, ' of PUMP.',
    ]);
  });

  it('lists events in log order and states the facts', () => {
    expect(eventRows(SWAP).map((e) => [e.li, e.kind, e.amount])).toEqual([
      [1, 'Transfer', '476.93 USDC'], [2, 'Transfer', '476.93 USDC'], [3, 'Swap', null], [4, 'Transfer', '476.93 USDC'],
    ]);
    expect(eventRows(SWAP)[2]!.parts).toEqual(['pool ', '0x6c96ee62…dd79e8', ' · sender ', { addr: R.ROUTER }]);
    expect(txFacts(SWAP)).toEqual({ protocol: 'Uniswap v4', pool: R.SWAP_POOL, parties: [R.SWAP_PAYER, R.SWAP_HOP, R.ROUTER, R.POOLMANAGER] });
    expect(legsLabel(SWAP)).toBe('3 USDC movements · 1 swap');
    expect(tokenAddresses(SWAP)).toEqual([R.ZERO, R.SWAP_TOKEN]);
  });

  it('draws the chain as nodes and edges', () => {
    expect(flowView(SWAP.transfers)).toEqual({
      nodes: [
        { role: 'Payer', address: R.SWAP_PAYER }, { role: 'Through', address: R.SWAP_HOP },
        { role: 'Through', address: R.ROUTER }, { role: 'Arrived at', address: R.POOLMANAGER },
      ],
      edges: [{ amount: '476.93', li: 1 }, { amount: '476.93', li: 2 }, { amount: '476.93', li: 4 }],
    });
  });
});

describe('other swaps', () => {
  it('writes "swapped for" when USDC came out of the pool', () => {
    const tx = base({
      transfers: [t(5, R.POOLMANAGER, R.SWAP_PAYER, 10)],
      swaps: [{ li: 4, pool: R.SWAP_POOL, sender: R.ROUTER, amount0: R.usdc(10), amount1: `-${R.SWAP_RECEIVED}`, fee: 2500 }],
      pools: { [R.SWAP_POOL]: POOL },
    });
    expect(txHeadline(tx)).toEqual([{ addr: R.SWAP_PAYER }, ' swapped for ', { b: '10.00 USDC' }, ' on Uniswap v4.']);
    expect(txPath(tx, TOKENS).slice(-3)).toEqual([' It was paid for with ', { b: '13,763,833.33' }, ' of PUMP.']);
  });

  it('falls back when the pool is unknown or the token has no decimals', () => {
    const tx = base({ swaps: SWAP.swaps });
    expect(txHeadline(tx)).toEqual(['A swap on Uniswap v4.']);
    expect(swapView(SWAP.swaps[0]!, undefined, {})).toMatchObject({ known: false, paid: null, received: null });
    expect(swapView(SWAP.swaps[0]!, POOL, { [R.SWAP_TOKEN]: { symbol: null, decimals: null } }).received).toEqual({
      amount: '13,763,833,330,793,760,056,038,261 (decimals unknown)', token: '0x6e71…b777', tokenAddress: R.SWAP_TOKEN,
    });
  });
});

describe('transfers without a swap', () => {
  it('writes a payment', () => {
    const tx = base({ transfers: [{ li: 0, from: R.PAYER, to: R.PAYEE, value: R.usdc(311, 55) }] });
    expect(txHeadline(tx)).toEqual([{ addr: R.PAYER }, ' paid ', { addr: R.PAYEE }, ' ', { b: '311.55 USDC' }, '.']);
    expect(txPath(tx, {})).toEqual(['In block ', { b: '24,787,775' }, ' at 20:33:32 UTC.']);
    expect(legsLabel(tx)).toBe('1 USDC movement');
  });

  it('writes a chain from its first payer to its last payee', () => {
    const tx = base({ transfers: [t(0, R.CHAIN[0]!, R.CHAIN[1]!, 50), t(1, R.CHAIN[1]!, R.CHAIN[2]!, 50), t(2, R.CHAIN[2]!, R.CHAIN[3]!, 50)] });
    expect(isChain(tx.transfers)).toBe(true);
    expect(txHeadline(tx)).toEqual([{ addr: R.CHAIN[0] }, ' paid ', { addr: R.CHAIN[3] }, ' ', { b: '50.00 USDC' }, '.']);
  });

  it('writes mints, burns and self-transfers', () => {
    expect(txHeadline(base({ transfers: [t(0, R.ZERO, R.MINTEE, 10000)] }))).toEqual([{ b: '10,000.00 USDC' }, ' were minted to ', { addr: R.MINTEE }, '.']);
    expect(txHeadline(base({ transfers: [t(0, R.MINTEE, R.ZERO, 5)] }))).toEqual([{ b: '5.00 USDC' }, ' were burned from ', { addr: R.MINTEE }, '.']);
    expect(txHeadline(base({ transfers: [t(0, R.SELF, R.SELF, 1)] }))).toEqual([{ addr: R.SELF }, ' sent ', { b: '1.00 USDC' }, ' to itself.']);
  });

  it('sums movements that do not form a chain, and draws no flow for them', () => {
    const tx = base({ transfers: [t(0, R.PAYER, R.PAYEE, 1), t(1, R.CHAIN[0]!, R.CHAIN[1]!, 2)] });
    expect(txHeadline(tx)).toEqual([{ b: '2' }, ' USDC movements in this transaction, ', { b: '3.00 USDC' }, ' in all.']);
    expect(flowView(tx.transfers)).toBeNull();
  });

  it('draws no flow for a chain longer than six', () => {
    const hops = Array.from({ length: 7 }, (_, i) => t(i, `0x${String(i).repeat(40)}`, `0x${String(i + 1).repeat(40)}`, 1));
    expect(isChain(hops)).toBe(true);
    expect(flowView(hops)).toBeNull();
  });
});

describe('pool events without USDC', () => {
  it('names what happened to the pool', () => {
    const init = { li: 3, pool: R.SWAP_POOL, currency0: R.ZERO, currency1: R.SWAP_TOKEN, fee: 2500, tickSpacing: 50, hooks: R.ZERO };
    expect(txHeadline(base({ inits: [init] }))).toEqual(['A Uniswap v4 pool was created.']);
    const modify = { li: 0, pool: R.SWAP_POOL, sender: R.LP, tickLower: -600, tickUpper: 600, liquidityDelta: '-5' };
    expect(txHeadline(base({ modifies: [modify] }))).toEqual(['Liquidity changed in a Uniswap v4 pool.']);
    expect(eventRows(base({ modifies: [modify] }))[0]!.parts).toEqual(['pool ', '0x6c96ee62…dd79e8', ' · removed by ', { addr: R.LP }]);
    const donate = { li: 1, pool: R.SWAP_POOL, sender: R.LP, amount0: '1', amount1: '0' };
    expect(txHeadline(base({ donates: [donate] }))).toEqual(['A donation to a Uniswap v4 pool.']);
    expect(eventRows(base({ inits: [init] }))[0]!.parts).toEqual(['pool ', '0x6c96ee62…dd79e8', ' created · fee ', '0.25%']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/txstory.test.ts`
Expected: FAIL — `../lib/txstory.js` not found.

- [ ] **Step 3: Implement `lib/txstory.ts`**

```ts
import { ZERO_ADDRESS, fmtAmount, fmtFee, fmtInt, fmtTime, shortAddr, shortHash, unitsToDecimal } from './format.js';
import type { Part } from './parts.js';
import type { TokenMeta } from './tokens.js';
import type { PoolInfo, TxData, TxSwap, TxTransfer } from './tx.js';

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const usdc = (raw: string | bigint): string => `${fmtAmount(unitsToDecimal(raw))} USDC`;
const plural = (n: number, one: string, many: string): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

export function isChain(ts: TxTransfer[]): boolean {
  return ts.every((t, i) => i === 0 || ts[i - 1]!.to === t.from);
}

function andList(addresses: string[]): Part[] {
  const out: Part[] = [];
  addresses.forEach((a, i) => {
    if (i > 0) out.push(i === addresses.length - 1 ? ' and ' : ', ');
    out.push({ addr: a });
  });
  return out;
}

// The USDC side of a swap, as the swapper's delta; null when neither currency is native USDC.
function usdcDelta(s: TxSwap, pool: PoolInfo | undefined): bigint | null {
  if (!pool) return null;
  if (pool.currency0 === ZERO_ADDRESS) return BigInt(s.amount0);
  if (pool.currency1 === ZERO_ADDRESS) return BigInt(s.amount1);
  return null;
}

export function txHeadline(tx: TxData): Part[] {
  const T = tx.transfers;
  const s = tx.swaps[0];
  if (s) {
    const d = usdcDelta(s, tx.pools[s.pool]);
    if (d !== null && d < 0n) return [{ addr: T[0]?.from ?? s.sender }, ' swapped ', { b: usdc(abs(d)) }, ' on Uniswap v4.'];
    if (d !== null && d > 0n) return [{ addr: T.at(-1)?.to ?? s.sender }, ' swapped for ', { b: usdc(d) }, ' on Uniswap v4.'];
    return ['A swap on Uniswap v4.'];
  }
  if (!T.length) {
    if (tx.inits.length) return ['A Uniswap v4 pool was created.'];
    if (tx.modifies.length) return ['Liquidity changed in a Uniswap v4 pool.'];
    return ['A donation to a Uniswap v4 pool.'];
  }
  const first = T[0]!;
  const last = T.at(-1)!;
  if (isChain(T)) {
    if (first.from === ZERO_ADDRESS) return [{ b: usdc(last.value) }, ' were minted to ', { addr: last.to }, '.'];
    if (last.to === ZERO_ADDRESS) return [{ b: usdc(first.value) }, ' were burned from ', { addr: first.from }, '.'];
    if (T.length === 1 && first.from === first.to) return [{ addr: first.from }, ' sent ', { b: usdc(first.value) }, ' to itself.'];
    return [{ addr: first.from }, ' paid ', { addr: last.to }, ' ', { b: usdc(first.value) }, '.'];
  }
  const total = T.reduce((n, t) => n + BigInt(t.value), 0n);
  return [{ b: fmtInt(T.length) }, ' USDC movements in this transaction, ', { b: usdc(total) }, ' in all.'];
}

export interface SwapSide {
  amount: string;
  token: string;
  tokenAddress: string;
}

export interface SwapView {
  li: number;
  pool: string;
  paid: SwapSide | null;
  received: SwapSide | null;
  fee: string;
  known: boolean;
}

function side(address: string, delta: bigint, meta: TokenMeta | undefined): SwapSide {
  const decimals = address === ZERO_ADDRESS ? 18 : (meta?.decimals ?? null);
  const amount = decimals === null ? `${fmtInt(abs(delta))} (decimals unknown)` : fmtAmount(unitsToDecimal(abs(delta), decimals));
  const token = address === ZERO_ADDRESS ? 'USDC (native)' : (meta?.symbol ?? shortAddr(address));
  return { amount, token, tokenAddress: address };
}

// Uniswap v4 logs Swap amounts as the swapper's balance deltas: negative was
// paid into the pool, positive came out of it. Checked on mainnet tx
// 0x9a83…015a: amount0 −476.9325 native USDC paid, amount1 +13.76M received.
export function swapView(s: TxSwap, pool: PoolInfo | undefined, tokens: Record<string, TokenMeta>): SwapView {
  if (!pool) return { li: s.li, pool: s.pool, paid: null, received: null, fee: fmtFee(s.fee), known: false };
  const sides = [[pool.currency0, BigInt(s.amount0)], [pool.currency1, BigInt(s.amount1)]] as const;
  const paid = sides.find(([, d]) => d < 0n);
  const received = sides.find(([, d]) => d > 0n);
  return {
    li: s.li,
    pool: s.pool,
    paid: paid ? side(paid[0], paid[1], tokens[paid[0]]) : null,
    received: received ? side(received[0], received[1], tokens[received[0]]) : null,
    fee: fmtFee(s.fee),
    known: true,
  };
}

export function txPath(tx: TxData, tokens: Record<string, TokenMeta>): Part[] {
  const T = tx.transfers;
  const at = ` at ${fmtTime(tx.time)} UTC.`;
  const out: Part[] = [];
  if (T.length >= 2 && isChain(T)) {
    const via = andList(T.slice(1).map((t) => t.from));
    out.push('The USDC went from ', { addr: T[0]!.from }, ' through ', ...via, ' to ', { addr: T.at(-1)!.to }, ' in block ', { b: fmtInt(tx.block) }, at);
  } else {
    out.push('In block ', { b: fmtInt(tx.block) }, at);
  }
  const s = tx.swaps[0];
  if (s) {
    const v = swapView(s, tx.pools[s.pool], tokens);
    if (v.received && v.received.tokenAddress !== ZERO_ADDRESS) out.push(' It came back as ', { b: v.received.amount }, ` of ${v.received.token}.`);
    else if (v.paid && v.paid.tokenAddress !== ZERO_ADDRESS) out.push(' It was paid for with ', { b: v.paid.amount }, ` of ${v.paid.token}.`);
  }
  return out;
}

export interface FlowView {
  nodes: { role: string; address: string }[];
  edges: { amount: string; li: number }[];
}

// "How the money moved" as nodes and arrows, when the transfers form one chain of at most six.
export function flowView(ts: TxTransfer[]): FlowView | null {
  if (!ts.length || ts.length > 6 || !isChain(ts)) return null;
  const addresses = [ts[0]!.from, ...ts.map((t) => t.to)];
  return {
    nodes: addresses.map((address, i) => ({ role: i === 0 ? 'Payer' : i === addresses.length - 1 ? 'Arrived at' : 'Through', address })),
    edges: ts.map((t) => ({ amount: fmtAmount(unitsToDecimal(t.value)), li: t.li })),
  };
}

export interface EventRow {
  li: number;
  kind: 'Transfer' | 'Swap' | 'Liquidity' | 'Donate' | 'Initialize';
  parts: Part[];
  amount: string | null;
}

export function eventRows(tx: TxData): EventRow[] {
  const rows: EventRow[] = [
    ...tx.transfers.map((t): EventRow => ({ li: t.li, kind: 'Transfer', parts: [{ addr: t.from }, ' → ', { addr: t.to }], amount: usdc(t.value) })),
    ...tx.swaps.map((s): EventRow => ({ li: s.li, kind: 'Swap', parts: ['pool ', shortHash(s.pool), ' · sender ', { addr: s.sender }], amount: null })),
    ...tx.modifies.map((m): EventRow => ({
      li: m.li, kind: 'Liquidity', parts: ['pool ', shortHash(m.pool), BigInt(m.liquidityDelta) < 0n ? ' · removed by ' : ' · added by ', { addr: m.sender }], amount: null,
    })),
    ...tx.donates.map((d): EventRow => ({ li: d.li, kind: 'Donate', parts: ['pool ', shortHash(d.pool), ' · from ', { addr: d.sender }], amount: null })),
    ...tx.inits.map((i): EventRow => ({ li: i.li, kind: 'Initialize', parts: ['pool ', shortHash(i.pool), ' created · fee ', fmtFee(i.fee)], amount: null })),
  ];
  return rows.sort((a, b) => a.li - b.li);
}

export function txFacts(tx: TxData): { protocol: string; pool: string | null; parties: string[] } {
  const poolEvents = [...tx.swaps, ...tx.modifies, ...tx.donates, ...tx.inits];
  const parties = [...new Set(tx.transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a !== ZERO_ADDRESS).slice(0, 8);
  return { protocol: poolEvents.length ? 'Uniswap v4' : 'USDC', pool: poolEvents[0]?.pool ?? null, parties };
}

export function legsLabel(tx: TxData): string {
  const parts = [plural(tx.transfers.length, 'USDC movement', 'USDC movements')];
  if (tx.swaps.length) parts.push(plural(tx.swaps.length, 'swap', 'swaps'));
  return parts.join(' · ');
}

// The pool currencies a page needs symbols for (address(0) is answered without a call).
export function tokenAddresses(tx: TxData): string[] {
  return [...new Set(Object.values(tx.pools).flatMap((p) => [p.currency0, p.currency1]))];
}
```

- [ ] **Step 4: Run the test**

Run: `corepack pnpm --filter @arckive/explorer test -- test/txstory.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): transaction headline, path, swap box, events and facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 7: Address data and sentences

**Files:**
- Create: `packages/explorer/lib/address.ts`, `packages/explorer/lib/addrstory.ts`
- Test: `packages/explorer/test/address.test.ts`, `packages/explorer/test/addrstory.test.ts`

**Interfaces:**
- Consumes: `Tables`, `hexToBytes`, `bytesToHex` (Task 3), `Rollup` (Task 4, in tests), format, lanes, names, `Part` (Task 2).
- Produces:
  - `address.ts`: `interface AddressTotals { inValue: string; outValue: string; inCount: number; outCount: number; firstDay: string | null; lastDay: string | null }`, `interface DayBar { day: string; inValue: string; outValue: string }`, `interface HistoryRow { block: number; li: number; tx: string; time: number; dir: 'in' | 'out' | 'self'; counterparty: string; value: string; lane: string | null }`, `interface HistoryPage { rows: HistoryRow[]; older: string | null }`, `interface Recent { total: number; counterparties: { address: string; count: number; value: string }[]; lanes: Record<string, number> }`, `type Before = { block: number; li: number }`, `parseBefore(s: string | undefined): Before | null`, `addressId(pool, t, address): Promise<number | null>`, `totals(pool, id): Promise<AddressTotals>`, `days(pool, id): Promise<DayBar[]>`, `history(pool, t, lanes: boolean, id, before: Before | null, size?: number): Promise<HistoryPage>`, `recent(pool, t, lanes: boolean, id, n?: number): Promise<Recent>`.
  - `addrstory.ts`: `topLane(lanes: Record<string, number>): string | null`, `addressHeadline(a: { address: string; totals: AddressTotals; topLane: string | null }): Part[]`, `netOf(t: AddressTotals): string`, `interface ChartBar { day: string; x: number; inH: number; outH: number }`, `chartBars(days: DayBar[], width?: number, half?: number): { bars: ChartBar[]; barWidth: number }`.

- [ ] **Step 1: Write the failing tests**

`packages/explorer/test/address.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { ensureExplorerSchema } from '../lib/explorer-schema.js';
import { Rollup } from '../lib/rollup.js';
import { addressId, days, history, parseBefore, recent, totals } from '../lib/address.js';

const key = (r: { block: number; li: number }) => `${r.block}-${r.li}`;
const busyIn = R.BUSY_ROWS.filter((r) => r.to === R.BUSY);
const busyOut = R.BUSY_ROWS.filter((r) => r.from === R.BUSY);

for (const lanes of [true, false]) {
  describe(`address pages (lanes ${lanes ? 'on' : 'not yet on'})`, () => {
    let db: TestDb;
    let id: number;
    beforeAll(async () => {
      db = await startDb({ insights: lanes });
      await ensureExplorerSchema(db.explorer);
      const r = new Rollup(db.explorer, db.t);
      while ((await r.step()) === 'more');
      id = (await addressId(db.explorer, db.t, R.BUSY))!;
    });
    afterAll(async () => { await db?.stop(); });

    it('finds known addresses only', async () => {
      expect(id).toEqual(expect.any(Number));
      expect(await addressId(db.explorer, db.t, R.UNSEEN)).toBeNull();
    });

    it('totals the whole history from the rollup, a self-transfer on both sides', async () => {
      const sum = (rows: readonly R.Transfer[]) => rows.reduce((n, r) => n + BigInt(r.value), 0n).toString();
      expect(await totals(db.explorer, id)).toEqual({
        inValue: sum(busyIn), outValue: sum(busyOut), inCount: busyIn.length, outCount: busyOut.length,
        firstDay: '2026-10-07', lastDay: '2026-10-08',
      });
    });

    it('gives one bar per day', async () => {
      expect((await days(db.explorer, id)).map((d) => d.day)).toEqual(['2026-10-07', '2026-10-08']);
    });

    it('pages the history newest first with no gaps or repeats', async () => {
      const p1 = await history(db.explorer, db.t, lanes, id, null);
      expect(p1.rows).toHaveLength(25);
      expect(p1.older).toBe(key(p1.rows[24]!));
      const p2 = await history(db.explorer, db.t, lanes, id, parseBefore(p1.older!));
      expect(p2.rows).toHaveLength(R.BUSY_ROWS.length - 25);
      expect(p2.older).toBeNull();
      const seen = [...p1.rows, ...p2.rows].map(key);
      expect(new Set(seen).size).toBe(seen.length);
      expect(new Set(seen)).toEqual(new Set(R.BUSY_ROWS.map((r) => `${r.n}-${r.li}`)));
      const order = [...seen].sort((a, b) => {
        const [ab, al] = a.split('-').map(Number) as [number, number];
        const [bb, bl] = b.split('-').map(Number) as [number, number];
        return bb - ab || bl - al;
      });
      expect(seen).toEqual(order);
    });

    it('reads direction, counterparty and lane per row', async () => {
      const rows = (await history(db.explorer, db.t, lanes, id, null, 100)).rows;
      const self = rows.find((r) => r.block === R.busyBlock(15))!;
      expect(self).toMatchObject({ dir: 'self', counterparty: R.BUSY });
      const top = rows[0]!;
      expect(top).toMatchObject({ block: R.busyBlock(29), li: 1, dir: 'in', counterparty: R.CPS[0], value: R.usdc(0, 1), lane: null });
      const read = rows.find((r) => r.block === R.busyBlock(0))!;
      expect(read.lane).toBe(lanes ? 'payment' : null);
      expect(read.time).toBe(Date.UTC(2026, 9, 7, 23, 59, 40) / 1000);
    });

    it('summarises the latest movements', async () => {
      const r = await recent(db.explorer, db.t, lanes, id);
      expect(r.total).toBe(R.BUSY_ROWS.length);
      // ten movements each; ties go to the larger sum (CPS[2] 166.25, CPS[1] 156.25, CPS[0] 130.26 USDC)
      expect(r.counterparties.slice(0, 3).map((c) => [c.address, c.count])).toEqual([[R.CPS[2], 10], [R.CPS[1], 10], [R.CPS[0], 10]]);
      expect(r.counterparties[0]!.value).toBe('166250000000000000000');
      if (lanes) expect(r.lanes).toEqual({ payment: 10, signed_payment: 10 });
      else expect(r.lanes).toEqual({});
    });
  });
}

describe('parseBefore', () => {
  it('reads a keyset cursor and ignores anything else', () => {
    expect(parseBefore('24861160-1')).toEqual({ block: 24861160, li: 1 });
    for (const s of [undefined, '', 'abc', '1-2-3', '-1-0', '1-', '99999999999999999999-0']) expect(parseBefore(s)).toBeNull();
  });
});
```

`packages/explorer/test/addrstory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addressHeadline, chartBars, netOf, topLane } from '../lib/addrstory.js';
import type { AddressTotals } from '../lib/address.js';

const T = (over: Partial<AddressTotals> = {}): AddressTotals => ({
  inValue: '48211070000000000000000', outValue: '47950000000000000000000', inCount: 700, outCount: 514,
  firstDay: '2026-06-03', lastDay: '2026-10-07', ...over,
});

describe('address sentences', () => {
  it('writes the headline without claiming wallet or contract', () => {
    expect(addressHeadline({ address: `0x${'ab'.repeat(20)}`, totals: T(), topLane: 'payment' })).toEqual([
      'This address', ' received ', { b: '48,211.07 USDC' }, ' and sent ', { b: '47,950.00 USDC' },
      ' across ', { b: '1,214' }, ' movements', ' since 3 June 2026', ' — mostly ', { b: 'payments' }, '.',
    ]);
  });

  it('names a named contract and drops the lane clause when there is none', () => {
    const parts = addressHeadline({ address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', totals: T({ inCount: 1, outCount: 0 }), topLane: null });
    expect(parts[0]).toEqual({ b: 'Uniswap v4 Pools' });
    expect(parts).toContain(' movement');
    expect(parts.at(-1)).toBe('.');
  });

  it('picks the busiest lane, never "uncertain", ties in lane order', () => {
    expect(topLane({ payment: 3, swap: 3 })).toBe('swap');
    expect(topLane({ uncertain: 9, payment: 1 })).toBe('payment');
    expect(topLane({})).toBeNull();
  });

  it('nets in minus out exactly', () => {
    expect(netOf(T())).toBe('261.07');
    expect(netOf(T({ inValue: '0', outValue: '5' }))).toBe('-0.000000000000000005');
  });
});

describe('chartBars', () => {
  it('draws one slot per day, gaps included, on a square-root scale', () => {
    const E18 = '000000000000000000';
    const { bars, barWidth } = chartBars([
      { day: '2026-10-01', inValue: `100${E18}`, outValue: '0' },
      { day: '2026-10-03', inValue: `25${E18}`, outValue: `100${E18}` },
    ], 840, 80);
    expect(bars.map((b) => b.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(bars[0]).toMatchObject({ inH: 80, outH: 0 });
    expect(bars[1]).toMatchObject({ inH: 0, outH: 0 });
    expect(bars[2]).toMatchObject({ inH: 40, outH: 80 });
    expect(barWidth).toBeGreaterThan(0);
  });
  it('draws nothing for no days', () => {
    expect(chartBars([]).bars).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/address.test.ts test/addrstory.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `lib/address.ts`**

```ts
import type pg from 'pg';
import { bytesToHex, hexToBytes, type Tables } from './db.js';

export interface AddressTotals {
  inValue: string;
  outValue: string;
  inCount: number;
  outCount: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface DayBar {
  day: string;
  inValue: string;
  outValue: string;
}

export interface HistoryRow {
  block: number;
  li: number;
  tx: string;
  time: number;
  dir: 'in' | 'out' | 'self';
  counterparty: string;
  value: string;
  lane: string | null;
}

export interface HistoryPage {
  rows: HistoryRow[];
  older: string | null; // ?before= for the next page
}

export interface Recent {
  total: number;
  counterparties: { address: string; count: number; value: string }[];
  lanes: Record<string, number>;
}

export interface Before {
  block: number;
  li: number;
}

const MAX_BLOCK = '9223372036854775807';
const MAX_LI = 2147483647;

// ?before=<block>-<log>; anything else is the first page.
export function parseBefore(s: string | undefined): Before | null {
  const m = /^(\d{1,15})-(\d{1,9})$/.exec(s ?? '');
  return m ? { block: Number(m[1]), li: Number(m[2]) } : null;
}

export async function addressId(pool: pg.Pool, t: Tables, address: string): Promise<number | null> {
  const r = await pool.query<{ id: number }>(`SELECT id FROM ${t.addresses} WHERE address = $1`, [hexToBytes(address)]);
  return r.rowCount ? r.rows[0]!.id : null;
}

// Whole-history totals from the rollup, never from scanning the transfers.
export async function totals(pool: pg.Pool, id: number): Promise<AddressTotals> {
  const r = await pool.query<{ i: string | null; o: string | null; ic: number | null; oc: number | null; f: string | null; l: string | null }>(
    `SELECT sum(in_value)::text AS i, sum(out_value)::text AS o, sum(in_count)::int AS ic, sum(out_count)::int AS oc,
            min(day)::text AS f, max(day)::text AS l
     FROM explorer.address_daily WHERE address_id = $1`,
    [id],
  );
  const x = r.rows[0]!;
  return { inValue: x.i ?? '0', outValue: x.o ?? '0', inCount: x.ic ?? 0, outCount: x.oc ?? 0, firstDay: x.f, lastDay: x.l };
}

export async function days(pool: pg.Pool, id: number): Promise<DayBar[]> {
  const r = await pool.query<{ day: string; i: string; o: string }>(
    'SELECT day::text AS day, in_value::text AS i, out_value::text AS o FROM explorer.address_daily WHERE address_id = $1 ORDER BY day',
    [id],
  );
  return r.rows.map((x) => ({ day: x.day, inValue: x.i, outValue: x.o }));
}

// The latest `limit` rows of an address before a keyset position: two index
// scans (from_id, to_id — storage.addressIndexes orders both by block and
// log) merged; UNION drops the self-transfer both scans find.
function latestSql(t: Tables, limit: string): string {
  const cols = 'block_number, log_index, tx_hash, from_id, to_id, value';
  const scan = (col: string): string =>
    `(SELECT ${cols} FROM ${t.usdc} WHERE ${col} = $1 AND (block_number, log_index) < ($2::bigint, $3::int)
      ORDER BY block_number DESC, log_index DESC LIMIT ${limit})`;
  return `WITH h AS (${scan('from_id')} UNION ${scan('to_id')}),
  page AS (SELECT * FROM h ORDER BY block_number DESC, log_index DESC LIMIT ${limit})`;
}

export async function history(pool: pg.Pool, t: Tables, lanes: boolean, id: number, before: Before | null, size = 25): Promise<HistoryPage> {
  const r = await pool.query<{ n: string; li: number; tx: Buffer; f: number; r: number; fa: Buffer; ta: Buffer; v: string; t: string; lane?: string | null }>(
    `${latestSql(t, '$4')}
     SELECT p.block_number::text AS n, p.log_index AS li, p.tx_hash AS tx, p.from_id AS f, p.to_id AS r, fa.address AS fa, ta.address AS ta,
            p.value::text AS v, extract(epoch from b.block_time)::bigint::text AS t${lanes ? ', i.lane' : ''}
     FROM page p
     JOIN ${t.blocks} b ON b.block_number = p.block_number
     JOIN ${t.addresses} fa ON fa.id = p.from_id
     JOIN ${t.addresses} ta ON ta.id = p.to_id
     ${lanes ? `LEFT JOIN ${t.insights} i ON i.block_number = p.block_number AND i.log_index = p.log_index` : ''}
     ORDER BY p.block_number DESC, p.log_index DESC`,
    [id, before ? String(before.block) : MAX_BLOCK, before ? before.li : MAX_LI, size + 1],
  );
  const rows = r.rows.slice(0, size).map((x): HistoryRow => {
    const dir = x.f === x.r ? 'self' : x.r === id ? 'in' : 'out';
    return {
      block: Number(x.n), li: x.li, tx: bytesToHex(x.tx), time: Number(x.t), dir,
      counterparty: bytesToHex(dir === 'in' ? x.fa : x.ta), value: x.v, lane: x.lane ?? null,
    };
  });
  const last = rows.at(-1);
  return { rows, older: r.rows.length > size && last ? `${last.block}-${last.li}` : null };
}

// Counterparties and lanes over the latest n movements, labelled so on the page.
export async function recent(pool: pg.Pool, t: Tables, lanes: boolean, id: number, n = 1000): Promise<Recent> {
  const args = [id, MAX_BLOCK, MAX_LI, n];
  const cps = await pool.query<{ a: Buffer; c: number; v: string; total: number }>(
    `${latestSql(t, '$4')}
     SELECT a.address AS a, x.c, x.v::text AS v, x.total FROM (
       SELECT CASE WHEN to_id = $1 THEN from_id ELSE to_id END AS cp, count(*)::int AS c, sum(value) AS v,
              sum(count(*)) OVER ()::int AS total
       FROM page GROUP BY 1
     ) x JOIN ${t.addresses} a ON a.id = x.cp ORDER BY x.c DESC, x.v DESC LIMIT 6`,
    args,
  );
  const out: Recent = {
    total: cps.rows[0]?.total ?? 0,
    counterparties: cps.rows.map((x) => ({ address: bytesToHex(x.a), count: x.c, value: x.v })),
    lanes: {},
  };
  if (lanes) {
    const lr = await pool.query<{ lane: string; c: number }>(
      `${latestSql(t, '$4')}
       SELECT i.lane, count(*)::int AS c FROM page p JOIN ${t.insights} i ON i.block_number = p.block_number AND i.log_index = p.log_index GROUP BY 1`,
      args,
    );
    for (const x of lr.rows) out.lanes[x.lane] = x.c;
  }
  return out;
}
```

- [ ] **Step 4: Implement `lib/addrstory.ts`**

```ts
import { fmtAmount, fmtDay, fmtInt, unitsToDecimal } from './format.js';
import { LANE_ORDER, laneMeta } from './lanes.js';
import { nameOf } from './names.js';
import type { Part } from './parts.js';
import type { AddressTotals, DayBar } from './address.js';

export function topLane(lanes: Record<string, number>): string | null {
  let best: string | null = null;
  for (const lane of LANE_ORDER) {
    if (lane === 'uncertain') continue;
    const n = lanes[lane] ?? 0;
    if (n > 0 && (best === null || n > (lanes[best] ?? 0))) best = lane;
  }
  return best;
}

// Contract or wallet is not known without a call, so it is not claimed: a
// named contract is called by its name, anything else "This address".
export function addressHeadline(a: { address: string; totals: AddressTotals; topLane: string | null }): Part[] {
  const name = nameOf(a.address);
  const n = a.totals.inCount + a.totals.outCount;
  const parts: Part[] = [
    name ? { b: name } : 'This address',
    ' received ', { b: `${fmtAmount(unitsToDecimal(a.totals.inValue))} USDC` },
    ' and sent ', { b: `${fmtAmount(unitsToDecimal(a.totals.outValue))} USDC` },
    ' across ', { b: fmtInt(n) }, n === 1 ? ' movement' : ' movements',
  ];
  if (a.totals.firstDay) parts.push(` since ${fmtDay(a.totals.firstDay)}`);
  if (a.topLane) parts.push(' — mostly ', { b: laneMeta(a.topLane).plural }, '.');
  else parts.push('.');
  return parts;
}

export function netOf(t: AddressTotals): string {
  return unitsToDecimal(BigInt(t.inValue) - BigInt(t.outValue));
}

export interface ChartBar {
  day: string;
  x: number;
  inH: number;
  outH: number;
}

const DAY_MS = 86_400_000;

// One slot per UTC day from the first to the last, empty days included;
// heights on a square-root scale so a quiet day still shows beside a busy one.
// Floats are fine here: these are pixels, not amounts.
export function chartBars(daysIn: DayBar[], width = 840, half = 82): { bars: ChartBar[]; barWidth: number } {
  if (!daysIn.length) return { bars: [], barWidth: 0 };
  const byDay = new Map(daysIn.map((d) => [d.day, d]));
  const start = Date.parse(`${daysIn[0]!.day}T00:00:00Z`);
  const end = Date.parse(`${daysIn.at(-1)!.day}T00:00:00Z`);
  const slots = Math.round((end - start) / DAY_MS) + 1;
  const value = (s: string): number => Number(unitsToDecimal(s));
  const top = Math.max(...daysIn.flatMap((d) => [value(d.inValue), value(d.outValue)]), 0);
  const scale = (v: number): number => (top > 0 ? Math.sqrt(v / top) * half : 0);
  const pitch = (width - 40) / slots;
  const barWidth = Math.max(1, pitch - Math.min(2, pitch / 4));
  const bars = Array.from({ length: slots }, (_, i): ChartBar => {
    const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const d = byDay.get(day);
    return { day, x: 20 + i * pitch, inH: d ? scale(value(d.inValue)) : 0, outH: d ? scale(value(d.outValue)) : 0 };
  });
  return { bars, barWidth };
}
```

- [ ] **Step 5: Run the tests**

Run: `corepack pnpm --filter @arckive/explorer test -- test/address.test.ts test/addrstory.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): address totals, keyset history, counterparties and headline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 8: Release rule, rolling window, hub and SSE framing

**Files:**
- Create: `packages/explorer/lib/release.ts`, `lib/window.ts`, `lib/hub.ts`, `lib/sse.ts`
- Test: `packages/explorer/test/release.test.ts`, `test/window.test.ts`, `test/hub.test.ts`

**Interfaces:**
- Consumes: `BlockMsg`, `Hello`, `StatsMsg`, `Move`, `Largest` (Task 2), `unitsToDecimal` (Task 2).
- Produces:
  - `release.ts`: `interface ReleaseInput { cursor: number | null; insightsCursor: number | null | undefined; heldThrough: number | null }` (`insightsCursor === undefined`: lanes are not on), `releaseTo(i: ReleaseInput): number | null`.
  - `window.ts`: `interface WindowMove extends Move { raw: bigint }`, `interface WindowBlock { n: number; t: number; moves: WindowMove[] }`, `class RollingWindow { constructor(spanSec?: number); add(b: WindowBlock): void; stats(now: number): StatsMsg }`.
  - `sse.ts`: `frame(event: string, data: unknown, id?: number): string`, `HEARTBEAT`, `RETRY`, `parseLastEventId(header: string | null, query: string | null): number | null`.
  - `hub.ts`: `interface Sink { send(chunk: string): boolean; close(): void }`, `class Hub { constructor(maxStreams: number, bufferMoves?: number); readonly size: number; full(): boolean; hello(): Hello; newest(): number | null; seed(blocks: BlockMsg[], releasedTo: number): void; subscribe(sink: Sink, lastEventId: number | null): (() => void) | null; publishBlock(b: BlockMsg): void; publishStats(s: StatsMsg): void; heartbeat(): void; closeAll(): void }`.

- [ ] **Step 1: Write the failing tests**

`packages/explorer/test/release.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { releaseTo } from '../lib/release.js';

describe('releaseTo', () => {
  it('releases everything the worker wrote when lanes are not on', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: undefined, heldThrough: null })).toBe(100);
  });
  it('releases up to the insights cursor', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: 95, heldThrough: 90 })).toBe(95);
  });
  it('releases blocks whose hold ran out even without their lanes', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: 80, heldThrough: 92 })).toBe(92);
  });
  it('never passes the worker cursor', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: 120, heldThrough: 130 })).toBe(100);
  });
  it('waits while lanes have not started and nothing is old enough', () => {
    expect(releaseTo({ cursor: 100, insightsCursor: null, heldThrough: null })).toBe(-1);
  });
  it('has nothing to release before the worker writes a cursor', () => {
    expect(releaseTo({ cursor: null, insightsCursor: 5, heldThrough: 5 })).toBeNull();
  });
});
```

`packages/explorer/test/window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RollingWindow, type WindowMove } from '../lib/window.js';

const E18 = 10n ** 18n;
const mv = (tx: string, li: number, whole: number, lane: string | null): WindowMove => ({
  tx, li, from: '0xa', to: '0xb', value: String(whole), raw: BigInt(whole) * E18, lane,
});

describe('RollingWindow', () => {
  it('counts the last 60 s of block time, summing exactly', () => {
    const w = new RollingWindow();
    w.add({ n: 1, t: 1000, moves: [mv('0x1', 0, 5, 'swap')] });
    w.add({ n: 2, t: 1030, moves: [mv('0x2', 0, 7, 'payment'), mv('0x2', 1, 1, null)] });
    let s = w.stats(123);
    expect(s).toMatchObject({ count: 3, usdc: '13', lanes: { swap: 1, payment: 1 }, now: 123 });
    w.add({ n: 3, t: 1061, moves: [mv('0x3', 0, 2, 'swap')] });
    s = w.stats(124);
    expect(s).toMatchObject({ count: 3, usdc: '10', lanes: { payment: 1, swap: 1 } });
  });

  it('lists the five largest movements, one per transaction', () => {
    const w = new RollingWindow();
    w.add({ n: 1, t: 1, moves: [mv('0xa', 0, 100, 'swap'), mv('0xa', 1, 90, 'swap'), mv('0xb', 0, 50, null)] });
    w.add({ n: 2, t: 2, moves: [1, 2, 3, 4, 5].map((i) => mv(`0xc${i}`, 0, i, 'payment')) });
    const largest = w.stats(0).largest;
    expect(largest.map((m) => [m.tx, m.value])).toEqual([['0xa', '100'], ['0xb', '50'], ['0xc5', '5'], ['0xc4', '4'], ['0xc3', '3']]);
    expect(largest[0]).toMatchObject({ n: 1, t: 1 });
    expect(largest[0]).not.toHaveProperty('raw');
  });

  it('rates per second over the time it has seen, up to a minute', () => {
    const w = new RollingWindow();
    w.add({ n: 1, t: 100, moves: [mv('0x1', 0, 1, null)] });
    w.add({ n: 2, t: 110, moves: Array.from({ length: 19 }, (_, i) => mv('0x2', i, 1, null)) });
    expect(w.stats(0).perSec).toBe(2);
  });
});
```

`packages/explorer/test/hub.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Hub, type Sink } from '../lib/hub.js';
import { HEARTBEAT, RETRY, frame, parseLastEventId } from '../lib/sse.js';
import type { BlockMsg, StatsMsg } from '../lib/types.js';

const block = (n: number, moves = 1): BlockMsg => ({
  n, t: 1000 + n, moves: Array.from({ length: moves }, (_, li) => ({ tx: `0x${n}`, li, from: '0xa', to: '0xb', value: '1', lane: null })),
});
const STATS: StatsMsg = { count: 1, usdc: '1', perSec: 1, lanes: {}, largest: [], now: 5 };

function sink(accept = true): Sink & { got: string[]; closed: boolean } {
  return { got: [], closed: false, send(c) { if (!accept) return false; this.got.push(c); return true; }, close() { this.closed = true; } };
}

describe('SSE framing', () => {
  it('writes id, event and one data line', () => {
    expect(frame('block', { a: 'x\ny' }, 7)).toBe('id: 7\nevent: block\ndata: {"a":"x\\ny"}\n\n');
    expect(frame('stats', { b: 1 })).toBe('event: stats\ndata: {"b":1}\n\n');
    expect(HEARTBEAT).toBe(': hb\n\n');
    expect(RETRY).toBe('retry: 3000\n\n');
  });
  it('reads Last-Event-ID from the header, else the query', () => {
    expect(parseLastEventId('42', null)).toBe(42);
    expect(parseLastEventId(null, '43')).toBe(43);
    expect(parseLastEventId('x', null)).toBeNull();
    expect(parseLastEventId(null, null)).toBeNull();
  });
});

describe('Hub', () => {
  it('greets a new viewer with the latest movements, at most 40', () => {
    const hub = new Hub(10);
    hub.seed([block(1, 30), block(2, 30)], 2);
    const s = sink();
    expect(hub.subscribe(s, null)).toEqual(expect.any(Function));
    expect(s.got[0]).toBe(RETRY);
    const hello = JSON.parse(s.got[1]!.split('data: ')[1]!);
    expect(hello.blocks.flatMap((b: BlockMsg) => b.moves)).toHaveLength(40);
    expect(s.got[1]).toMatch(/^id: 2\nevent: hello\n/);
  });

  it('resumes a viewer from Last-Event-ID while the buffer still holds what came after', () => {
    const hub = new Hub(10);
    hub.seed([block(10)], 10);
    for (const n of [11, 12, 13]) hub.publishBlock(block(n));
    hub.publishStats(STATS);
    const s = sink();
    hub.subscribe(s, 11);
    expect(s.got.slice(1)).toEqual([frame('block', block(12), 12), frame('block', block(13), 13), frame('stats', STATS)]);
  });

  it('sends a fresh hello when the buffer moved past the viewer', () => {
    const hub = new Hub(10, 2);
    hub.seed([block(10)], 10);
    for (const n of [11, 12, 13, 14]) hub.publishBlock(block(n));
    const s = sink();
    hub.subscribe(s, 10);
    expect(s.got[1]).toMatch(/event: hello/);
  });

  it('fans blocks, stats and heartbeats out, and drops a viewer that stops reading', () => {
    const hub = new Hub(10);
    const a = sink();
    const slow = sink();
    hub.subscribe(a, null);
    hub.subscribe(slow, null);
    slow.send = () => false;
    hub.publishBlock(block(1));
    expect(a.got.at(-1)).toBe(frame('block', block(1), 1));
    expect(slow.closed).toBe(true);
    expect(hub.size).toBe(1);
    hub.heartbeat();
    expect(a.got.at(-1)).toBe(HEARTBEAT);
  });

  it('refuses viewers beyond MAX_STREAMS and frees a slot on unsubscribe', () => {
    const hub = new Hub(1);
    const off = hub.subscribe(sink(), null)!;
    expect(hub.full()).toBe(true);
    expect(hub.subscribe(sink(), null)).toBeNull();
    off();
    expect(hub.subscribe(sink(), null)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/release.test.ts test/window.test.ts test/hub.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the four modules**

`packages/explorer/lib/release.ts`:

```ts
export interface ReleaseInput {
  cursor: number | null; // the worker's _cursor
  insightsCursor: number | null | undefined; // undefined: lanes are not on; null: on, not started
  heldThrough: number | null; // the newest block whose _ingested_at is older than LANE_HOLD_MS
}

// How far the tape may go. A row waits for its lane — up to the insights
// cursor — but at most LANE_HOLD_MS: a block older than the hold goes out
// without it. Never past the worker's cursor. With lanes not switched on
// there is nothing to wait for. (At ~14 movements a second a 32-row tape
// turns over every ~2 s; a lane filled in later would land on rows no one sees.)
export function releaseTo(i: ReleaseInput): number | null {
  if (i.cursor === null) return null;
  if (i.insightsCursor === undefined) return i.cursor;
  const lanes = Math.min(i.insightsCursor ?? -1, i.cursor);
  const held = Math.min(i.heldThrough ?? -1, i.cursor);
  return Math.max(lanes, held);
}
```

`packages/explorer/lib/window.ts`:

```ts
import { unitsToDecimal } from './format.js';
import type { Largest, Move, StatsMsg } from './types.js';

export interface WindowMove extends Move {
  raw: bigint; // the value in wei, for exact sums and comparisons
}

export interface WindowBlock {
  n: number;
  t: number;
  moves: WindowMove[];
}

type Held = WindowMove & { n: number; t: number };

// The tape's last minute, by block time rather than the clock: a tailer
// catching up after a stall still counts the minute the chain had.
export class RollingWindow {
  #moves: Held[] = [];
  #newest = 0;
  #first: number | null = null;

  constructor(private readonly spanSec = 60) {}

  add(b: WindowBlock): void {
    for (const m of b.moves) this.#moves.push({ ...m, n: b.n, t: b.t });
    this.#newest = Math.max(this.#newest, b.t);
    this.#first ??= b.t;
    const floor = this.#newest - this.spanSec;
    let drop = 0;
    while (drop < this.#moves.length && this.#moves[drop]!.t <= floor) drop++;
    if (drop) this.#moves.splice(0, drop);
  }

  stats(now: number): StatsMsg {
    let sum = 0n;
    const lanes: Record<string, number> = {};
    const perTx = new Map<string, Held>();
    for (const m of this.#moves) {
      sum += m.raw;
      if (m.lane) lanes[m.lane] = (lanes[m.lane] ?? 0) + 1;
      const best = perTx.get(m.tx);
      if (!best || m.raw > best.raw) perTx.set(m.tx, m);
    }
    const largest: Largest[] = [...perTx.values()]
      .sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0))
      .slice(0, 5)
      .map((m) => {
        const out: Largest = { tx: m.tx, li: m.li, from: m.from, to: m.to, value: m.value, lane: m.lane, n: m.n, t: m.t };
        if (m.fromName) out.fromName = m.fromName;
        if (m.toName) out.toName = m.toName;
        return out;
      });
    const seen = this.#first === null ? 1 : this.#newest - this.#first;
    const span = Math.max(1, Math.min(this.spanSec, seen));
    return { count: this.#moves.length, usdc: unitsToDecimal(sum), perSec: Math.round((this.#moves.length / span) * 10) / 10, lanes, largest, now };
  }
}
```


`packages/explorer/lib/sse.ts`:

```ts
// Server-Sent Events framing. JSON.stringify never emits a raw newline, so
// each payload is one data line.
export function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A comment line every 15 s keeps proxies (Cloudflare closes after 100 s idle) from cutting the stream.
export const HEARTBEAT = ': hb\n\n';
export const RETRY = 'retry: 3000\n\n';

// The browser resends the last id as a header on its own reconnects; the
// client's own reconnects (after a 503) pass it as ?last=.
export function parseLastEventId(header: string | null, query: string | null): number | null {
  const v = (header ?? query ?? '').trim();
  return /^\d{1,15}$/.test(v) ? Number(v) : null;
}
```

`packages/explorer/lib/hub.ts`:

```ts
import { HEARTBEAT, RETRY, frame } from './sse.js';
import type { BlockMsg, Hello, StatsMsg } from './types.js';

export interface Sink {
  // false: the viewer stopped reading; the hub closes it
  send(chunk: string): boolean;
  close(): void;
}

// The tailer's fan-out: the latest movements and stats for viewers who
// connect, and every block and stats message to every open stream.
export class Hub {
  #blocks: BlockMsg[] = [];
  #stats: StatsMsg | null = null;
  readonly #sinks = new Set<Sink>();
  // the newest block no longer whole in the buffer: a viewer who saw it can resume
  #trimmedThrough = -1;

  constructor(
    readonly maxStreams: number,
    private readonly bufferMoves = 40,
  ) {}

  get size(): number {
    return this.#sinks.size;
  }

  full(): boolean {
    return this.#sinks.size >= this.maxStreams;
  }

  newest(): number | null {
    return this.#blocks.at(-1)?.n ?? null;
  }

  // the latest bufferMoves movements, oldest block first
  hello(): Hello {
    const out: BlockMsg[] = [];
    let left = this.bufferMoves;
    for (let i = this.#blocks.length - 1; i >= 0 && left > 0; i--) {
      const b = this.#blocks[i]!;
      const moves = b.moves.slice(Math.max(0, b.moves.length - left));
      left -= moves.length;
      out.unshift({ ...b, moves });
    }
    return { blocks: out, stats: this.#stats };
  }

  // The buffer at start, from the database; nothing is sent. Its first block
  // may be partial, so a viewer must have seen at least that one to resume.
  seed(blocks: BlockMsg[], releasedTo: number): void {
    this.#blocks = [...blocks];
    this.#trimmedThrough = blocks[0]?.n ?? releasedTo;
    this.#trim();
  }

  #trim(): void {
    let moves = this.#blocks.reduce((n, b) => n + b.moves.length, 0);
    while (this.#blocks.length > 1 && moves - this.#blocks[0]!.moves.length >= this.bufferMoves) {
      const b = this.#blocks.shift()!;
      moves -= b.moves.length;
      this.#trimmedThrough = Math.max(this.#trimmedThrough, b.n);
    }
  }

  subscribe(sink: Sink, lastEventId: number | null): (() => void) | null {
    if (this.full()) return null;
    this.#sinks.add(sink);
    let ok = sink.send(RETRY);
    if (lastEventId !== null && lastEventId >= this.#trimmedThrough) {
      for (const b of this.#blocks) if (ok && b.n > lastEventId) ok = sink.send(frame('block', b, b.n));
      if (ok && this.#stats) ok = sink.send(frame('stats', this.#stats));
    } else if (ok) {
      ok = sink.send(frame('hello', this.hello(), this.newest() ?? undefined));
    }
    if (!ok) this.#drop(sink);
    return () => {
      this.#sinks.delete(sink);
    };
  }

  publishBlock(b: BlockMsg): void {
    this.#blocks.push(b);
    this.#trim();
    this.#broadcast(frame('block', b, b.n));
  }

  publishStats(s: StatsMsg): void {
    this.#stats = s;
    this.#broadcast(frame('stats', s));
  }

  heartbeat(): void {
    this.#broadcast(HEARTBEAT);
  }

  closeAll(): void {
    for (const s of this.#sinks) this.#drop(s);
  }

  #broadcast(chunk: string): void {
    for (const s of this.#sinks) if (!s.send(chunk)) this.#drop(s);
  }

  #drop(s: Sink): void {
    this.#sinks.delete(s);
    s.close();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm --filter @arckive/explorer test -- test/release.test.ts test/window.test.ts test/hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): release rule, rolling minute, SSE hub and framing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 9: Tailer, runtime, instrumentation and API routes

**Files:**
- Create: `packages/explorer/lib/tailer.ts`, `lib/streamroute.ts`, `lib/runtime.ts`, `packages/explorer/instrumentation.ts`, `app/api/stream/route.ts`, `app/api/tx/[hash]/lane/route.ts`, `app/api/health/route.ts`
- Test: `packages/explorer/test/tailer.test.ts`, `test/streamroute.test.ts`, `test/runtime.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces:
  - `tailer.ts`: `CYCLE_MS`, `STATS_MS`, `HEARTBEAT_MS`, `interface TailerDeps { pool: pg.Pool; t: Tables; hub: Hub; holdMs: number; lanes: () => boolean; log: Logger }`, `class Tailer { lastReleased: number | null; readonly window: RollingWindow; constructor(d: TailerDeps); init(): Promise<void>; cycle(): Promise<void>; cycleStats(): { last: number | null; p95: number | null }; start(): () => void }`.
  - `streamroute.ts`: `streamResponse(hub: Hub, req: Request): Response`.
  - `runtime.ts`: `class ArchiveUnavailable extends Error`, `interface Head { block: number; time: number }`, `interface Runtime { cfg; pool; t; hub; tokens; tailer; rollup; ready: boolean; insights: InsightsInfo; head: Head | null; dbBytes: number | null; rolledTo: number | null; stop(): void }`, `createRuntime(cfg: Config, reader?: TokenReader): Runtime`, `bootRuntime(rt: Runtime, exit?: (code: number) => void): Promise<void>`, `getRuntime(): Runtime`, `readyRuntime(): Runtime`.

- [ ] **Step 1: Write the failing tests**

`packages/explorer/test/tailer.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { Hub, type Sink } from '../lib/hub.js';
import { log } from '../lib/log.js';
import { nameOf } from '../lib/names.js';
import { Tailer } from '../lib/tailer.js';

function collector(): Sink & { got: string[] } {
  return { got: [], send(c) { this.got.push(c); return true; }, close() {} };
}
const blocksIn = (got: string[]) => got.filter((c) => c.includes('event: block')).map((c) => JSON.parse(c.split('data: ')[1]!));

describe('tailer (lanes on)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db?.stop(); });

  it('holds fresh rows for their lane, then releases them when the hold runs out', async () => {
    await db.admin.query(`UPDATE ${db.t.blocks} SET _ingested_at = now()`);
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 8000, lanes: () => true, log });
    await tailer.init();
    // everything was ingested just now: only blocks with lanes go out
    expect(tailer.lastReleased).toBe(R.INSIGHTS_CURSOR);
    expect(hub.newest()).toBe(R.INSIGHTS_CURSOR);
    const viewer = collector();
    hub.subscribe(viewer, null);

    await tailer.cycle();
    expect(blocksIn(viewer.got)).toEqual([]);

    await db.admin.query(`UPDATE ${db.t.blocks} SET _ingested_at = now() - interval '1 minute' WHERE block_number <= $1`, [R.busyBlock(25)]);
    await tailer.cycle();
    const sent = blocksIn(viewer.got);
    expect(sent.map((b) => b.n)).toEqual([20, 21, 22, 23, 24, 25].map(R.busyBlock));
    expect(sent[0].moves[0]).toMatchObject({ lane: null, to: R.BUSY, value: '21.25' });
    expect(tailer.lastReleased).toBe(R.busyBlock(25));
  });

  it('names known contracts and attaches lanes', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 0, lanes: () => true, log });
    tailer.lastReleased = 24787774;
    await tailer.cycle();
    const swap = hub.hello().blocks.find((b) => b.n === 24787775);
    // the cycle skipped far ahead (more than 600 blocks behind): only the last ~150 blocks are sent
    expect(swap).toBeUndefined();
    tailer.lastReleased = 24787774;
    (tailer as unknown as { maxGap: number }).maxGap = Number.MAX_SAFE_INTEGER;
    const viewer = collector();
    hub.subscribe(viewer, null);
    await tailer.cycle();
    const first = blocksIn(viewer.got)[0];
    expect(first.n).toBe(24787775);
    expect(first.moves[2]).toMatchObject({ from: R.ROUTER, to: R.POOLMANAGER, toName: 'Uniswap v4 Pools', lane: 'swap', value: '476.9325', tx: R.SWAP_TX, li: 4 });
    expect(first.moves[2].fromName).toBe(nameOf(R.ROUTER));
  });

  it('publishes stats on its timer and stops cleanly', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 0, lanes: () => true, log });
    const viewer = collector();
    hub.subscribe(viewer, null);
    const stop = tailer.start();
    await new Promise((r) => setTimeout(r, 1500));
    stop();
    expect(viewer.got.some((c) => c.includes('event: stats'))).toBe(true);
    expect(tailer.cycleStats().last).toEqual(expect.any(Number));
  });
});

describe('tailer (lanes not on yet)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb({ insights: false }); });
  afterAll(async () => { await db?.stop(); });

  it('releases up to the worker cursor at once, without lanes', async () => {
    const hub = new Hub(10);
    const tailer = new Tailer({ pool: db.explorer, t: db.t, hub, holdMs: 8000, lanes: () => false, log });
    await tailer.init();
    expect(tailer.lastReleased).toBe(R.CURSOR);
    const moves = hub.hello().blocks.flatMap((b) => b.moves);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.lane === null)).toBe(true);
  });
});
```

`packages/explorer/test/streamroute.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Hub } from '../lib/hub.js';
import { streamResponse } from '../lib/streamroute.js';
import type { BlockMsg } from '../lib/types.js';

const block = (n: number): BlockMsg => ({ n, t: n, moves: [{ tx: `0x${n}`, li: 0, from: '0xa', to: '0xb', value: '1', lane: null }] });

async function firstChunks(res: Response, n: number): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (let i = 0; i < n; i++) {
    const r = await reader.read();
    if (r.done) break;
    text += dec.decode(r.value);
  }
  return { text, reader };
}

describe('GET /api/stream', () => {
  it('opens an event stream that starts with hello', async () => {
    const hub = new Hub(5);
    hub.seed([block(1)], 1);
    const res = streamResponse(hub, new Request('http://x/api/stream'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const { text, reader } = await firstChunks(res, 2);
    expect(text).toContain('retry: 3000');
    expect(text).toContain('event: hello');
    await reader.cancel();
    expect(hub.size).toBe(0);
  });

  it('resumes from Last-Event-ID or ?last=', async () => {
    const hub = new Hub(5);
    hub.seed([block(1)], 1);
    hub.publishBlock(block(2));
    hub.publishBlock(block(3));
    for (const req of [
      new Request('http://x/api/stream', { headers: { 'Last-Event-ID': '2' } }),
      new Request('http://x/api/stream?last=2'),
    ]) {
      const { text, reader } = await firstChunks(streamResponse(hub, req), 2);
      expect(text).toContain('id: 3\nevent: block');
      expect(text).not.toContain('event: hello');
      await reader.cancel();
    }
  });

  it('answers 503 beyond MAX_STREAMS', async () => {
    const hub = new Hub(1);
    const open = streamResponse(hub, new Request('http://x/api/stream'));
    const busy = streamResponse(hub, new Request('http://x/api/stream'));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
    await open.body!.cancel();
    expect(streamResponse(hub, new Request('http://x/api/stream')).status).toBe(200);
  });
});
```

`packages/explorer/test/runtime.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDb, type TestDb } from './fixture/db.ts';
import * as R from './fixture/rows.ts';
import { loadConfig } from '../lib/config.js';
import { bootRuntime, createRuntime } from '../lib/runtime.js';

const reader = { read: async () => ({ symbol: null, decimals: null }) };

describe('runtime', () => {
  let db: TestDb;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db?.stop(); });

  it('boots: checks the schema, creates its tables, starts the tailer and the rollup', async () => {
    const rt = createRuntime(loadConfig({ DATABASE_URL: db.explorerUrl }), reader);
    try {
      await bootRuntime(rt, () => { throw new Error('should not exit'); });
      expect(rt.ready).toBe(true);
      expect(rt.insights).toEqual({ on: true, firstBlock: R.FIRST_LANE_BLOCK, firstTime: expect.any(Number) });
      expect(rt.head).toEqual({ block: R.CURSOR, time: Date.UTC(2026, 9, 8, 0, 0, 38) / 1000 });
      expect(rt.dbBytes).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 1500));
      expect(rt.hub.newest()).not.toBeNull();
      expect(await rt.rollup.rolledTo()).toBe(R.CURSOR);
    } finally {
      rt.stop();
      await rt.pool.end();
    }
  });

  it('exits when the schema is not the one it reads', async () => {
    const rt = createRuntime(loadConfig({ DATABASE_URL: db.explorerUrl, USDC_TABLE: 'usdc_transfers' }), reader);
    let code: number | null = null;
    try {
      await bootRuntime(rt, (c) => { code = c; });
      expect(code).toBe(1);
      expect(rt.ready).toBe(false);
    } finally {
      rt.stop();
      await rt.pool.end();
    }
  });
});
```

The head's time is block `busyBlock(29)`'s: `2026-10-07T23:59:40Z + 29 × 2 s = 2026-10-08T00:00:38Z`.

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/tailer.test.ts test/streamroute.test.ts test/runtime.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `lib/tailer.ts`**

```ts
import type pg from 'pg';
import { bytesToHex, type Tables } from './db.js';
import { unitsToDecimal } from './format.js';
import type { Hub } from './hub.js';
import { errText, type Logger } from './log.js';
import { nameOf } from './names.js';
import { releaseTo } from './release.js';
import type { BlockMsg, Move } from './types.js';
import { RollingWindow, type WindowBlock, type WindowMove } from './window.js';

export const CYCLE_MS = 250;
export const STATS_MS = 1000;
export const HEARTBEAT_MS = 15_000;
// A tailer further behind than this (a stall, a restart) skips to the last
// ~minute of blocks instead of replaying the gap at viewers.
const MAX_GAP = 600;
const CATCHUP = 150;
const MAX_ROWS = 50_000;

// a stream message carries the decimal value only, never the bigint
function toMove(m: WindowMove): Move {
  const out: Move = { tx: m.tx, li: m.li, from: m.from, to: m.to, value: m.value, lane: m.lane };
  if (m.fromName) out.fromName = m.fromName;
  if (m.toName) out.toName = m.toName;
  return out;
}

interface MoveRow {
  n: string;
  t: string;
  tx: Buffer;
  li: number;
  f: Buffer;
  r: Buffer;
  v: string;
  lane?: string | null;
}

export interface TailerDeps {
  pool: pg.Pool;
  t: Tables;
  hub: Hub;
  holdMs: number;
  lanes: () => boolean; // whether the _insights tables exist (refreshed by the runtime)
  log: Logger;
}

// One loop per process: every 250 ms it reads the worker's cursors, decides
// how far to release (release.ts), reads the released blocks' transfers with
// their lanes and addresses, publishes one `block` message per block and
// folds them into the rolling minute; stats go out once a second.
export class Tailer {
  lastReleased: number | null = null;
  readonly window = new RollingWindow();
  private maxGap = MAX_GAP;
  readonly #timings: number[] = [];

  constructor(private readonly d: TailerDeps) {}

  #movesSql(where: string, order: string): string {
    const { t } = this.d;
    const lanes = this.d.lanes();
    return `SELECT x.block_number::text AS n, extract(epoch from b.block_time)::bigint::text AS t, x.tx_hash AS tx, x.log_index AS li,
       fa.address AS f, ta.address AS r, x.value::text AS v${lanes ? ', i.lane' : ''}
     FROM ${t.usdc} x
     JOIN ${t.blocks} b ON b.block_number = x.block_number
     JOIN ${t.addresses} fa ON fa.id = x.from_id
     JOIN ${t.addresses} ta ON ta.id = x.to_id
     ${lanes ? `LEFT JOIN ${t.insights} i ON i.block_number = x.block_number AND i.log_index = x.log_index` : ''}
     WHERE ${where} ORDER BY ${order} LIMIT ${MAX_ROWS}`;
  }

  #group(rows: MoveRow[]): { msgs: BlockMsg[]; win: WindowBlock[] } {
    const win: WindowBlock[] = [];
    for (const r of rows) {
      const n = Number(r.n);
      if (win.at(-1)?.n !== n) win.push({ n, t: Number(r.t), moves: [] });
      const from = bytesToHex(r.f);
      const to = bytesToHex(r.r);
      const m: WindowMove = { tx: bytesToHex(r.tx), li: r.li, from, to, value: unitsToDecimal(r.v), raw: BigInt(r.v), lane: r.lane ?? null };
      const fromName = nameOf(from);
      const toName = nameOf(to);
      if (fromName) m.fromName = fromName;
      if (toName) m.toName = toName;
      win.at(-1)!.moves.push(m);
    }
    const msgs = win.map((b) => ({ n: b.n, t: b.t, moves: b.moves.map(toMove) }));
    return { msgs, win };
  }

  async #target(): Promise<number | null> {
    const { t, pool, holdMs } = this.d;
    const lanes = this.d.lanes();
    const r = await pool.query<{ cursor: string | null; icursor: string | null; held: string | null }>(
      `SELECT (SELECT last_block FROM ${t.cursor} WHERE id = 1)::text AS cursor,
              ${lanes ? `(SELECT last_block FROM ${t.insightsCursor} WHERE id = 1)::text` : 'NULL::text'} AS icursor,
              (SELECT max(block_number) FROM ${t.blocks}
                WHERE block_number > $1 AND _ingested_at <= now() - make_interval(secs => $2::float8 / 1000))::text AS held`,
      [this.lastReleased ?? -1, holdMs],
    );
    const row = r.rows[0]!;
    const num = (v: string | null): number | null => (v === null ? null : Number(v));
    return releaseTo({ cursor: num(row.cursor), insightsCursor: lanes ? num(row.icursor) : undefined, heldThrough: num(row.held) });
  }

  // The buffer and the rolling minute from the database: the last ~minute of
  // released blocks, so a restart neither greets viewers with an empty tape
  // nor under-counts the headline.
  async init(): Promise<void> {
    const to = await this.#target();
    if (to === null || to < 0) return;
    const r = await this.d.pool.query<MoveRow>(
      this.#movesSql('x.block_number > $1 AND x.block_number <= $2', 'x.block_number, x.log_index'),
      [to - CATCHUP, to],
    );
    const { msgs, win } = this.#group(r.rows);
    for (const b of win) this.window.add(b);
    this.d.hub.seed(msgs, to);
    this.lastReleased = to;
  }

  async cycle(): Promise<void> {
    const started = performance.now();
    try {
      if (this.lastReleased === null) return await this.init();
      const to = await this.#target();
      if (to === null || to <= this.lastReleased) return;
      const from = to - this.lastReleased > this.maxGap ? to - CATCHUP : this.lastReleased;
      const r = await this.d.pool.query<MoveRow>(
        this.#movesSql('x.block_number > $1 AND x.block_number <= $2', 'x.block_number, x.log_index'),
        [from, to],
      );
      const { msgs, win } = this.#group(r.rows);
      msgs.forEach((m, i) => {
        this.window.add(win[i]!);
        this.d.hub.publishBlock(m);
      });
      this.lastReleased = to;
    } finally {
      this.#timings.push(performance.now() - started);
      if (this.#timings.length > 200) this.#timings.shift();
    }
  }

  cycleStats(): { last: number | null; p95: number | null } {
    if (!this.#timings.length) return { last: null, p95: null };
    const s = [...this.#timings].sort((a, b) => a - b);
    const round = (v: number): number => Math.round(v * 10) / 10;
    return { last: round(this.#timings.at(-1)!), p95: round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!) };
  }

  start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      let wait = CYCLE_MS;
      try {
        await this.cycle();
      } catch (err) {
        // the database is down or slow: try again in a second; streams stay open
        wait = 1000;
        this.d.log.warn({ err: errText(err) }, 'tailer cycle failed');
      }
      if (!stopped) timer = setTimeout(loop, wait);
    };
    void loop();
    const stats = setInterval(() => this.d.hub.publishStats(this.window.stats(Date.now())), STATS_MS);
    const beat = setInterval(() => this.d.hub.heartbeat(), HEARTBEAT_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(stats);
      clearInterval(beat);
    };
  }
}
```


- [ ] **Step 4: Implement `lib/streamroute.ts`**

```ts
import type { Hub, Sink } from './hub.js';
import { parseLastEventId } from './sse.js';

const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform: the server's gzip must not buffer the stream
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

// GET /api/stream. A viewer whose queue fills (it stopped reading) is
// dropped rather than buffered without end; its client notices the silence
// and reconnects with ?last=.
export function streamResponse(hub: Hub, req: Request): Response {
  const last = parseLastEventId(req.headers.get('last-event-id'), new URL(req.url).searchParams.get('last'));
  const enc = new TextEncoder();
  const sub: { off: (() => void) | null } = { off: null };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const sink: Sink = {
          send(chunk) {
            if ((controller.desiredSize ?? 1) <= 0) return false;
            controller.enqueue(enc.encode(chunk));
            return true;
          },
          close() {
            try {
              controller.close();
            } catch {
              // already closed by the viewer
            }
          },
        };
        sub.off = hub.subscribe(sink, last);
      },
      cancel() {
        sub.off?.();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 64 }),
  );
  if (!sub.off) {
    return new Response('Too many viewers right now; the page retries on its own.', {
      status: 503,
      headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
    });
  }
  req.signal.addEventListener('abort', () => sub.off?.(), { once: true });
  return new Response(stream, { headers: HEADERS });
}
```

- [ ] **Step 5: Implement `lib/runtime.ts`**

```ts
import type pg from 'pg';
import { loadConfig, type Config } from './config.js';
import { createPool, tables, type Tables } from './db.js';
import { ensureExplorerSchema } from './explorer-schema.js';
import { Hub } from './hub.js';
import { errText, log } from './log.js';
import { Rollup } from './rollup.js';
import { SchemaError, checkSchema, hasInsights } from './schema.js';
import { Tailer } from './tailer.js';
import { Tokens, rpcTokenReader, type TokenReader } from './tokens.js';
import { loadInsightsInfo, type InsightsInfo } from './tx.js';

export class ArchiveUnavailable extends Error {}

export interface Head {
  block: number;
  time: number;
}

export interface Runtime {
  cfg: Config;
  pool: pg.Pool;
  t: Tables;
  hub: Hub;
  tokens: Tokens;
  tailer: Tailer;
  rollup: Rollup;
  ready: boolean;
  insights: InsightsInfo;
  head: Head | null;
  dbBytes: number | null;
  rolledTo: number | null;
  stop(): void;
}

const REFRESH_MS = 5000;
// what stop() undoes: the boot loop, the tailer, the rollup, the refresh timer
const STOPS = new WeakMap<Runtime, Array<() => void>>();

export function createRuntime(cfg: Config, reader: TokenReader = rpcTokenReader(cfg.arcRpc)): Runtime {
  const pool = createPool(cfg);
  // an idle client's error (the database restarting) must not crash the process
  pool.on('error', (err) => log.warn({ err: errText(err) }, 'idle database client failed'));
  const t = tables(cfg);
  const hub = new Hub(cfg.maxStreams);
  const stops: Array<() => void> = [];
  const rt: Runtime = {
    cfg, pool, t, hub,
    tokens: new Tokens(pool, reader),
    tailer: undefined as unknown as Tailer,
    rollup: new Rollup(pool, t),
    ready: false,
    insights: { on: false, firstBlock: null, firstTime: null },
    head: null,
    dbBytes: null,
    rolledTo: null,
    stop() {
      for (const s of stops.splice(0)) s();
      hub.closeAll();
    },
  };
  rt.tailer = new Tailer({ pool, t, hub, holdMs: cfg.laneHoldMs, lanes: () => rt.insights.on, log });
  STOPS.set(rt, stops);
  return rt;
}

async function refresh(rt: Runtime): Promise<void> {
  const on = await hasInsights(rt.pool, rt.t);
  // the first lane's block is read once it exists: older transactions predate lanes
  if (on !== rt.insights.on || (on && rt.insights.firstBlock === null)) rt.insights = await loadInsightsInfo(rt.pool, rt.t, on);
  const h = await rt.pool.query<{ n: string; t: string | null }>(
    `SELECT c.last_block::text AS n,
            (SELECT extract(epoch from b.block_time)::bigint::text FROM ${rt.t.blocks} b
              WHERE b.block_number <= c.last_block ORDER BY b.block_number DESC LIMIT 1) AS t
     FROM ${rt.t.cursor} c WHERE c.id = 1`,
  );
  rt.head = h.rowCount && h.rows[0]!.t !== null ? { block: Number(h.rows[0]!.n), time: Number(h.rows[0]!.t) } : null;
  const size = await rt.pool.query<{ b: string }>('SELECT pg_database_size(current_database())::text AS b');
  rt.dbBytes = Number(size.rows[0]!.b);
  rt.rolledTo = await rt.rollup.rolledTo();
}

// Retries a database that does not answer every second; stops the process
// (exit 1) when the schema is not the one the explorer reads — a clear error
// at start instead of a 500 on every page.
export async function bootRuntime(rt: Runtime, exit: (code: number) => void = (c) => process.exit(c)): Promise<void> {
  const stops = STOPS.get(rt)!;
  let stopped = false;
  stops.push(() => {
    stopped = true;
  });
  for (;;) {
    if (stopped) return;
    try {
      await checkSchema(rt.pool, rt.t);
      await ensureExplorerSchema(rt.pool);
      await refresh(rt);
      break;
    } catch (err) {
      if (err instanceof SchemaError) {
        log.fatal({ err: errText(err) }, 'the explorer cannot read this database');
        exit(1);
        return;
      }
      log.warn({ err: errText(err) }, 'database not answering; retrying');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (stopped) return;
  stops.push(rt.tailer.start(), rt.rollup.start(log));
  const timer = setInterval(() => {
    refresh(rt).catch((err) => log.warn({ err: errText(err) }, 'refresh failed'));
  }, REFRESH_MS);
  stops.push(() => clearInterval(timer));
  rt.ready = true;
  log.info({ schema: rt.t.schema, lanes: rt.insights.on }, 'explorer ready');
}

const KEY = Symbol.for('arckive.explorer.runtime');
type Global = typeof globalThis & { [KEY]?: Runtime };

// One runtime per process, kept on globalThis: Next bundles
// instrumentation.ts and each route separately, so a module-level singleton
// would exist once per bundle — two tailers, and streams that never see the tape.
export function getRuntime(): Runtime {
  // `next build` renders static pages without a database
  if (process.env['NEXT_PHASE'] === 'phase-production-build') throw new ArchiveUnavailable('no runtime during the build');
  const g = globalThis as Global;
  if (!g[KEY]) {
    const rt = createRuntime(loadConfig());
    g[KEY] = rt;
    void bootRuntime(rt);
  }
  return g[KEY];
}

export function readyRuntime(): Runtime {
  const rt = getRuntime();
  if (!rt.ready) throw new ArchiveUnavailable('the archive is not answering');
  return rt;
}
```


- [ ] **Step 6: Implement instrumentation and the routes**

`packages/explorer/instrumentation.ts`:

```ts
export async function register(): Promise<void> {
  // pg, the tailer and the rollup live in the Node.js runtime only
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { getRuntime } = await import('./lib/runtime.js');
  getRuntime();
}
```

`packages/explorer/app/api/stream/route.ts`:

```ts
import { getRuntime } from '../../../lib/runtime.js';
import { streamResponse } from '../../../lib/streamroute.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request): Response {
  return streamResponse(getRuntime().hub, req);
}
```

`packages/explorer/app/api/tx/[hash]/lane/route.ts`:

```ts
import { readyRuntime } from '../../../../../lib/runtime.js';
import { decodeParam, parseTxHash } from '../../../../../lib/search.js';
import { laneOrder, loadLane, loadTx } from '../../../../../lib/tx.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The transaction page polls this while Laya is reading the transaction.
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }): Promise<Response> {
  const hash = parseTxHash(decodeParam((await ctx.params).hash));
  if (!hash) return Response.json({ error: 'not a transaction hash' }, { status: 404 });
  try {
    const rt = readyRuntime();
    const tx = await loadTx(rt.pool, rt.t, hash);
    if (!tx) return Response.json({ error: 'no indexed event in this transaction' }, { status: 404 });
    const lane = await loadLane(rt.pool, rt.t, rt.insights, tx.block, laneOrder(tx));
    return Response.json({ lane }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'the archive is not answering' }, { status: 503 });
  }
}
```

`packages/explorer/app/api/health/route.ts`:

```ts
import { getRuntime } from '../../../lib/runtime.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Readiness for Kubernetes, and the numbers the real test reads.
export async function GET(): Promise<Response> {
  try {
    const rt = getRuntime();
    if (!rt.ready) return Response.json({ ok: false }, { status: 503 });
    await rt.pool.query('SELECT 1');
    return Response.json({
      ok: true,
      head: rt.head,
      released: rt.tailer.lastReleased,
      rolledTo: rt.rolledTo,
      lanes: rt.insights.on,
      streams: rt.hub.size,
      tailerMs: rt.tailer.cycleStats(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
```

- [ ] **Step 7: Run the tests and the build**

Run: `corepack pnpm --filter @arckive/explorer test`
Expected: PASS (all explorer tests so far).

Run: `NEXT_TELEMETRY_DISABLED=1 corepack pnpm --filter @arckive/explorer build`
Expected: build completes; `/api/stream`, `/api/health`, `/api/tx/[hash]/lane` listed as dynamic (ƒ).

- [ ] **Step 8: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): database tailer, SSE stream route, runtime and health

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 10: The page shell — styles, fonts, masthead, search, status, footer, error and 404

**Files:**
- Create: `packages/explorer/app/globals.css`, `components/Masthead.tsx`, `components/SearchBox.tsx`, `components/Status.tsx`, `components/Dateline.tsx`, `components/Footer.tsx`, `components/LaneTag.tsx`, `components/Addr.tsx`, `components/Parts.tsx`, `app/error.tsx`, `app/not-found.tsx`, `lib/live.ts`
- Modify: `packages/explorer/app/layout.tsx` (replace the placeholder), `packages/explorer/instrumentation.ts` (exit on a configuration error)
- Test: `packages/explorer/test/live.test.ts`

**Interfaces:**
- Consumes: format, lanes, names, search, `Part` (Task 2); `getRuntime` (Task 9).
- Produces: `lib/live.ts`: `type LiveState = { kind: 'live' } | { kind: 'behind'; seconds: number } | { kind: 'down' }`, `BEHIND_S = 15`, `liveState(newestBlockTime: number | null, nowMs: number, open?: boolean): LiveState`. Components: `<Masthead query? status />`, `<SearchBox initial />` (client), `<Status state={LiveState | null} />`, `<Dateline date />`, `<Footer />` (server), `<LaneTag lane label? />`, `<Addr address full? />`, `<Parts parts />`. Every component without `'use client'` and without database access is safe to render from a client component.

- [ ] **Step 1: Write the failing test for the live state**

`packages/explorer/test/live.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { liveState } from '../lib/live.js';

describe('liveState', () => {
  const now = 1_000_000 * 1000;
  it('is live within 15 s of the newest block', () => {
    expect(liveState(1_000_000 - 15, now)).toEqual({ kind: 'live' });
    expect(liveState(null, now)).toEqual({ kind: 'live' });
  });
  it('says how far behind it is past 15 s', () => {
    expect(liveState(1_000_000 - 42, now)).toEqual({ kind: 'behind', seconds: 42 });
  });
  it('says reconnecting while the stream is down', () => {
    expect(liveState(1_000_000, now, false)).toEqual({ kind: 'down' });
  });
});
```

- [ ] **Step 2: Run it to see it fail, then implement `lib/live.ts`**

Run: `corepack pnpm --filter @arckive/explorer test -- test/live.test.ts` → FAIL (module not found).

```ts
// The masthead's "● Arc mainnet, live": grey "reconnecting" while the stream
// is down, "n s behind" once the newest block is more than 15 s old.
export type LiveState = { kind: 'live' } | { kind: 'behind'; seconds: number } | { kind: 'down' };

export const BEHIND_S = 15;

export function liveState(newestBlockTime: number | null, nowMs: number, open = true): LiveState {
  if (!open) return { kind: 'down' };
  if (newestBlockTime === null) return { kind: 'live' };
  const lag = Math.round(nowMs / 1000 - newestBlockTime);
  return lag > BEHIND_S ? { kind: 'behind', seconds: lag } : { kind: 'live' };
}
```

Run the test again → PASS.

- [ ] **Step 3: Write `app/globals.css`**

Ported from the mockups (`docs/superpowers/specs/2026-10-08-arckive-explorer-mockups/*.html`), one stylesheet for every page:

```css
:root {
  --paper: #f4f1ea; --sheet: #faf8f3; --ink: #15171b; --dim: #5b616c; --faint: #8b8f97; --hair: #ddd6c9; --rule: #c9c1b2;
  --in: #1d8a57; --out: #b2412f; --live: #1f9d63; --late: #a87800;
  --serif: var(--font-serif), Georgia, serif;
  --sans: var(--font-sans), system-ui, sans-serif;
  --mono: var(--font-mono), ui-monospace, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.wrap { max-width: 1240px; margin: 0 auto; padding: 0 32px; }
.mono { font-family: var(--mono); }

/* masthead and dateline */
.mast { display: grid; grid-template-columns: 240px 1fr 240px; gap: 24px; align-items: center; min-height: 68px; border-bottom: 1px solid var(--ink); }
.mark { font: 500 13px var(--sans); letter-spacing: .16em; text-transform: uppercase; }
.mark span { color: var(--faint); }
.search { position: relative; margin: 0; }
.search input { width: 100%; height: 38px; border: 1px solid var(--rule); border-radius: 6px; background: var(--sheet); padding: 0 12px; font: 13px var(--mono); color: var(--ink); outline: none; }
.search input:focus { border-color: var(--ink); }
.search input::placeholder { color: var(--faint); font-family: var(--sans); }
.search .hint { position: absolute; left: 0; top: 42px; margin: 0; font-size: 12px; color: var(--out); z-index: 2; background: var(--paper); }
.net { justify-self: end; font-size: 12px; color: var(--dim); white-space: nowrap; }
.status b { font-weight: 600; color: var(--faint); }
.status.live b { color: var(--live); }
.status.behind b { color: var(--late); }
.status.down { color: var(--faint); }
.dateline { display: flex; justify-content: space-between; gap: 16px; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); padding: 8px 0; border-bottom: 3px double var(--ink); }

/* type */
h1 { font: 400 46px/1.14 var(--serif); margin: 0 0 14px; letter-spacing: -.01em; max-width: 1060px; overflow-wrap: anywhere; }
h1 b { font-weight: 500; font-variant-numeric: tabular-nums; }
h1 .mono { font: 400 34px var(--mono); letter-spacing: -.02em; }
.sub { font: 400 19px/1.55 var(--serif); color: var(--dim); max-width: 860px; margin: 0; }
.sub b { color: var(--ink); font-weight: 500; }
.sub .addr .mono { font-family: var(--serif); font-weight: 500; color: var(--ink); }
.crumb { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin: 26px 0 10px; }
.crumb a { color: var(--dim); }
h2 { font: 500 12px var(--sans); letter-spacing: .14em; text-transform: uppercase; margin: 0 0 10px; padding-bottom: 8px; border-bottom: 1px solid var(--ink); display: flex; justify-content: space-between; gap: 12px; }
h2 span { color: var(--faint); letter-spacing: .04em; text-transform: none; font-weight: 400; }
h2.gap { margin-top: 32px; }
.fig { font: italic 14px var(--serif); color: var(--dim); margin: 10px 0 0; }
.note { font-size: 13px; color: var(--late); margin: 14px 0 0; }
.cols { display: grid; grid-template-columns: 1fr 340px; gap: 44px; padding: 30px 0 44px; }
section, aside { min-width: 0; }
.addr { border-bottom: 1px solid var(--rule); }
.addr:hover { border-bottom-color: var(--ink); }
.addr .mono { font-size: .92em; }
.addr b { font-weight: 500; }
button.linklike { background: none; border: 0; padding: 0; font: inherit; color: var(--ink); border-bottom: 1px solid var(--rule); cursor: pointer; }
.empty { padding: 10px 0 90px; }

/* lane and event tags */
.tag { display: inline-flex; align-items: center; gap: 7px; font: 500 10.5px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--lane, var(--faint)); white-space: nowrap; }
.tag i { width: 7px; height: 7px; background: var(--lane, var(--faint)); display: inline-block; }
.tag.none i { display: none; }

/* home: headline, the tape, largest, by lane */
.head { padding: 34px 0 30px; border-bottom: 1px solid var(--hair); }
.head h1 { font-size: 50px; line-height: 1.12; max-width: 1020px; margin: 0; }
.head .fig { margin-top: 14px; font-size: 15px; }
.home { grid-template-columns: 1fr 330px; gap: 40px; padding: 26px 0 40px; }
.waiting { font: 500 11px var(--sans); letter-spacing: .08em; color: var(--sheet); background: var(--ink); padding: 2px 8px; border-radius: 10px; text-transform: none; }
.tape { height: 640px; overflow: hidden; }
.row { display: grid; grid-template-columns: 74px 128px 1fr 132px; gap: 14px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid var(--hair); animation: enter .45s ease; }
.row:hover, .row:focus-visible { background: var(--sheet); outline: none; }
@keyframes enter { from { opacity: 0; background: color-mix(in srgb, var(--lane) 14%, transparent); } }
.time { font: 12px var(--mono); color: var(--faint); }
.who { font: 12.5px var(--mono); color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who b { font-family: var(--sans); font-weight: 500; color: var(--ink); }
.amt { text-align: right; font: 18px var(--serif); font-variant-numeric: tabular-nums; }
.amt small { font: 10px var(--sans); letter-spacing: .1em; color: var(--faint); margin-left: 4px; }
.largest a { display: grid; grid-template-columns: 1fr auto; padding: 10px 0; border-bottom: 1px solid var(--hair); }
.largest a:hover { background: var(--sheet); }
.largest .n { font: 24px var(--serif); font-variant-numeric: tabular-nums; }
.largest .s { font: 12px var(--mono); color: var(--dim); grid-column: 1 / -1; margin-top: 2px; }
.largest .s b { font-family: var(--sans); font-weight: 500; color: var(--ink); }
.lanes { margin-top: 30px; }
.bar { display: grid; grid-template-columns: 110px 1fr 40px; gap: 10px; align-items: center; font-size: 12.5px; padding: 6px 0; }
.bar .track { height: 6px; background: var(--hair); }
.bar .track span { display: block; height: 100%; transition: width .6s ease; }
.bar em { font: 12px var(--mono); font-style: normal; text-align: right; color: var(--dim); }

/* transaction */
.flow { display: flex; align-items: stretch; margin: 8px 0 0; overflow-x: auto; padding: 18px 0 6px; }
.node { flex: 0 0 auto; max-width: 150px; padding: 12px 12px 10px; border: 1px solid var(--ink); background: var(--sheet); display: block; }
.node .k { display: block; font: 500 10.5px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.node .v { display: block; font: 13px var(--mono); margin-top: 6px; }
.node .v.named { font: 500 14px var(--sans); }
.edge { flex: 1; min-width: 78px; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 0 6px; }
.edge .amt { text-align: center; }
.edge .line { width: 100%; height: 1px; background: var(--ink); position: relative; margin: 6px 0; }
.edge .line::after { content: ''; position: absolute; right: -1px; top: -4px; border-left: 8px solid var(--ink); border-top: 4.5px solid transparent; border-bottom: 4.5px solid transparent; }
.edge .log { font: 11px var(--mono); color: var(--faint); }
.swapbox { margin-top: 26px; display: grid; grid-template-columns: 1fr 60px 1fr; align-items: center; border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair); padding: 18px 0; }
.swapbox .k { font: 500 10.5px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.swapbox .n { font: 34px var(--serif); font-variant-numeric: tabular-nums; margin-top: 4px; overflow-wrap: anywhere; }
.swapbox .t { font: 12.5px var(--mono); color: var(--dim); }
.swapbox .right { text-align: right; }
.swapbox .arrow { text-align: center; font: 28px var(--serif); color: var(--faint); }
.events .ev { display: grid; grid-template-columns: 52px 104px 1fr 130px; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--hair); align-items: baseline; font-size: 13px; }
.events .li { font: 12px var(--mono); color: var(--faint); }
.events .a { text-align: right; font: 17px var(--serif); font-variant-numeric: tabular-nums; }
.why { font: 17px/1.55 var(--serif); margin: 12px 0 18px; }
.why em { color: var(--dim); }
.conf { font: 12px var(--mono); color: var(--faint); }
dl.facts { display: grid; grid-template-columns: 120px 1fr; margin: 0; }
dl.facts dt, dl.facts dd { padding: 10px 0; border-bottom: 1px solid var(--hair); margin: 0; font-size: 13px; }
dl.facts dt { color: var(--faint); }
dl.facts dd { font-family: var(--mono); overflow-wrap: anywhere; }
dl.facts dd.parties .addr { display: table; margin-bottom: 4px; }

/* address */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--ink); border-bottom: 1px solid var(--hair); margin-top: 26px; }
.stats > div { padding: 14px 16px 14px 0; }
.stats > div + div { border-left: 1px solid var(--hair); padding-left: 16px; }
.stats .k { font: 500 10.5px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.stats .n { font: 30px var(--serif); font-variant-numeric: tabular-nums; margin-top: 4px; }
.stats .n.in { color: var(--in); }
.stats .n.out { color: var(--out); }
svg.chart { display: block; width: 100%; height: auto; }
svg.chart text { font: 11px var(--mono); fill: var(--faint); }
.hist .hrow { display: grid; grid-template-columns: 124px 46px 1fr 140px 104px 92px; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--hair); align-items: baseline; font-size: 13px; }
.hist .t { font: 12px var(--mono); color: var(--faint); }
.hist .dir { font: 600 10.5px var(--sans); letter-spacing: .12em; }
.hist .dir.in { color: var(--in); }
.hist .dir.out { color: var(--out); }
.hist .dir.self { color: var(--dim); }
.hist .a { text-align: right; font: 17px var(--serif); font-variant-numeric: tabular-nums; }
.hist .x { font: 12px var(--mono); color: var(--faint); text-align: right; }
.cp .cpr { display: grid; grid-template-columns: 1fr auto; padding: 10px 0; border-bottom: 1px solid var(--hair); }
.cp .w { font: 12.5px var(--mono); }
.cp .n { font: 18px var(--serif); font-variant-numeric: tabular-nums; }
.cp .s { grid-column: 1 / -1; font: 11.5px var(--sans); color: var(--faint); margin-top: 2px; }
.more { display: flex; justify-content: center; gap: 28px; padding: 14px 0; font-size: 12.5px; color: var(--dim); }

footer { border-top: 1px solid var(--ink); padding: 14px 0 30px; color: var(--faint); font-size: 12px; display: flex; justify-content: space-between; gap: 16px; }

@media (max-width: 900px) {
  .mast { grid-template-columns: 1fr auto; padding: 12px 0; row-gap: 10px; }
  .mast .search { grid-column: 1 / -1; order: 3; }
  .cols, .home { grid-template-columns: 1fr; }
  .head h1 { font-size: 36px; }
  h1 { font-size: 32px; }
  h1 .mono { font-size: 20px; }
  .stats { grid-template-columns: repeat(2, 1fr); }
  .stats > div:nth-child(3) { border-left: 0; padding-left: 0; }
}
@media (max-width: 520px) {
  .wrap { padding: 0 16px; }
  .dateline span + span { display: none; }
  .head h1 { font-size: 28px; }
  .tape { height: 560px; }
  .row { grid-template-columns: 62px 1fr 104px; }
  .row .who { display: none; }
  .swapbox { grid-template-columns: 1fr; gap: 14px; }
  .swapbox .arrow { display: none; }
  .swapbox .right { text-align: left; }
  .events .ev { grid-template-columns: 36px 1fr auto; }
  .events .ev .who { grid-column: 1 / -1; }
  .hist .hrow { grid-template-columns: 40px 1fr auto; }
  .hist .t, .hist .hrow .tag, .hist .x { display: none; }
  footer { flex-direction: column; }
}
```

- [ ] **Step 4: Write the shared components**

`packages/explorer/components/Addr.tsx`:

```tsx
import Link from 'next/link';
import { shortAddr } from '../lib/format.js';
import { nameOf } from '../lib/names.js';

// An address as its verified name or its short form, linked to its page.
export function Addr({ address, full = false }: { address: string; full?: boolean }) {
  const name = nameOf(address);
  return (
    <Link href={`/address/${address}`} className="addr" title={address} prefetch={false}>
      {name ? <b>{name}</b> : <span className="mono">{full ? address : shortAddr(address)}</span>}
    </Link>
  );
}
```

`packages/explorer/components/Parts.tsx`:

```tsx
import { Fragment } from 'react';
import type { Part } from '../lib/parts.js';
import { Addr } from './Addr.js';

export function Parts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{typeof p === 'string' ? p : 'b' in p ? <b>{p.b}</b> : <Addr address={p.addr} />}</Fragment>
      ))}
    </>
  );
}
```

`packages/explorer/components/LaneTag.tsx`:

```tsx
import type { CSSProperties } from 'react';
import { laneMeta } from '../lib/lanes.js';

export function LaneTag({ lane, label }: { lane: string | null; label?: string }) {
  const m = laneMeta(lane);
  return (
    <span className={lane === null ? 'tag none' : 'tag'} style={{ '--lane': m.ink } as CSSProperties}>
      <i />
      {label ?? m.label}
    </span>
  );
}
```

`packages/explorer/components/Status.tsx`:

```tsx
import { fmtInt } from '../lib/format.js';
import type { LiveState } from '../lib/live.js';

// null: a page that cannot know (a static 404) says only where it is.
export function Status({ state }: { state: LiveState | null }) {
  if (!state) return <span className="status">Arc mainnet</span>;
  const text =
    state.kind === 'live' ? 'Arc mainnet, live' : state.kind === 'behind' ? `Arc mainnet, ${fmtInt(state.seconds)} s behind` : 'Arc mainnet, reconnecting';
  return (
    <span className={`status ${state.kind}`} role="status">
      <b aria-hidden="true">●</b> {text}
    </span>
  );
}
```

`packages/explorer/components/Dateline.tsx`:

```tsx
export function Dateline({ date }: { date: string }) {
  return (
    <div className="dateline">
      <span>{date}</span>
      <span>USDC and Uniswap v4 on Arc, indexed by Arckive</span>
    </div>
  );
}
```

`packages/explorer/components/SearchBox.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { routeSearch } from '../lib/search.js';

export function SearchBox({ initial }: { initial: string }) {
  const router = useRouter();
  const [hint, setHint] = useState<string | null>(null);
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const v = new FormData(e.currentTarget).get('q');
    const r = routeSearch(typeof v === 'string' ? v : '');
    if ('href' in r) {
      setHint(null);
      router.push(r.href);
    } else {
      setHint(r.hint);
    }
  };
  return (
    <form className="search" role="search" onSubmit={onSubmit}>
      <input
        key={initial}
        name="q"
        defaultValue={initial}
        placeholder="Search a transaction hash or an address"
        aria-label="Search a transaction hash or an address"
        spellCheck={false}
        autoComplete="off"
      />
      {hint && (
        <p className="hint" role="status">
          {hint}
        </p>
      )}
    </form>
  );
}
```

`packages/explorer/components/Masthead.tsx`:

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SearchBox } from './SearchBox.js';

export function Masthead({ query = '', status }: { query?: string; status: ReactNode }) {
  return (
    <header className="mast">
      <Link href="/" className="mark">
        arckive <span>explorer</span>
      </Link>
      <SearchBox initial={query} />
      <div className="net">{status}</div>
    </header>
  );
}
```

`packages/explorer/components/Footer.tsx`:

```tsx
import { fmtBytes, fmtInt } from '../lib/format.js';
import { getRuntime } from '../lib/runtime.js';

// The database size is shown so a full disk is seen coming (100 GB holds
// about 140 days after launch).
export function Footer() {
  const facts: string[] = [];
  try {
    const rt = getRuntime();
    if (rt.head) facts.push(`block ${fmtInt(rt.head.block)}`);
    if (rt.dbBytes !== null) facts.push(`archive ${fmtBytes(rt.dbBytes)}`);
  } catch {
    // no runtime (the build, or before configuration): the footer stays plain
  }
  return (
    <footer>
      <span>Native USDC and the Uniswap v4 PoolManager on Arc mainnet, read from Arckive’s own archive.</span>
      <span>{facts.join(' · ') || 'Arc mainnet'}</span>
    </footer>
  );
}
```

- [ ] **Step 5: Replace the layout and add the error and 404 pages**

`packages/explorer/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '../components/Footer.js';
import './globals.css';

// next/font downloads these at build time and serves them from this app:
// no request to Google at runtime.
const serif = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], axes: ['opsz'], variable: '--font-serif', display: 'swap' });
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Arckive Explorer',
  description: 'Every USDC movement and Uniswap v4 pool event on Arc mainnet, from Arckive’s own archive.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="wrap">
          {children}
          <Footer />
        </div>
      </body>
    </html>
  );
}
```

`packages/explorer/app/error.tsx`:

```tsx
'use client';

import { Masthead } from '../components/Masthead.js';
import { Status } from '../components/Status.js';

// Shown when the database does not answer (or a query passes the role's 5 s
// statement timeout). Next sets the status code of a failed render; the API
// routes answer 503.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <Masthead status={<Status state={{ kind: 'down' }} />} />
      <main className="empty">
        <div className="crumb">Service unavailable</div>
        <h1>The archive is not answering; the tape will resume on its own.</h1>
        <p className="sub">
          Arckive’s database did not reply in time.{' '}
          <button type="button" className="linklike" onClick={reset}>
            Try again
          </button>
        </p>
      </main>
    </>
  );
}
```

`packages/explorer/app/not-found.tsx` (prerendered at build: no date, no live status):

```tsx
import { Masthead } from '../components/Masthead.js';
import { Status } from '../components/Status.js';

export default function NotFound() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <main className="empty">
        <div className="crumb">Not found</div>
        <h1>Nothing here.</h1>
        <p className="sub">Search a transaction hash or an address above.</p>
      </main>
    </>
  );
}
```

Update `packages/explorer/instrumentation.ts` so a missing or wrong configuration stops the process with its message (it never contains the DSN):

```ts
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
```

Update the placeholder home (`app/page.tsx`) so the shell can be seen until Task 11 replaces it:

```tsx
import { Dateline } from '../components/Dateline.js';
import { Masthead } from '../components/Masthead.js';
import { Status } from '../components/Status.js';
import { fmtDateLong } from '../lib/format.js';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <main className="empty">
        <h1>Arckive Explorer</h1>
      </main>
    </>
  );
}
```

- [ ] **Step 6: Build and look at it**

Run: `NEXT_TELEMETRY_DISABLED=1 corepack pnpm --filter @arckive/explorer build`
Expected: completes.

Run (a database that does not answer — pages that need it show the error page, the shell still renders):

```bash
cd packages/explorer && DATABASE_URL=postgres://x:y@127.0.0.1:1/x PORT=3999 NEXT_TELEMETRY_DISABLED=1 npx next start -p 3999 &
sleep 4
curl -s localhost:3999/ | grep -c 'explorer</span>'                # 1 or more: the masthead
curl -s -o /dev/null -w '%{http_code}\n' localhost:3999/nope        # 404
curl -s -o /dev/null -w '%{http_code}\n' localhost:3999/api/health  # 503
kill %1; cd ../..
```

Expected: the home HTML contains the masthead; `/nope` 404; `/api/health` 503.

- [ ] **Step 7: Lint, test and commit**

```bash
corepack pnpm lint && corepack pnpm --filter @arckive/explorer test -- test/live.test.ts
git add packages/explorer
git commit -m "feat(explorer): Broadsheet shell — styles, fonts, masthead, search, status, footer, error pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 11: The home page — the live tape

**Files:**
- Create: `packages/explorer/lib/pacing.ts`, `lib/stream-client.ts`, `lib/homestory.ts`, `components/HomeLive.tsx`
- Modify: `packages/explorer/app/page.tsx` (replace)
- Test: `packages/explorer/test/pacing.test.ts`, `test/stream-client.test.ts`, `test/homestory.test.ts`

**Interfaces:**
- Consumes: `Hello`, `BlockMsg`, `StatsMsg`, `Move` (Task 2); format, lanes, `Part`; components from Task 10; `getRuntime` (Task 9); `liveState` (Task 10).
- Produces:
  - `pacing.ts`: `interface PacerOptions { gapsKept; minGapMs; maxGapMs; defaultGapMs; maxBacklogMs; drainMs: number }`, `PACING`, `class Pacer<T> { constructor(o?: PacerOptions); interval(): number; push(items: readonly T[], now: number): void; take(now: number): T[]; pause(): void; resume(now: number): void; clear(): void; readonly waiting: number; readonly isPaused: boolean }`.
  - `stream-client.ts`: `interface StreamHandlers { hello(h: Hello): void; block(b: BlockMsg): void; stats(s: StatsMsg): void; state(open: boolean): void }`, `interface SourceLike { readyState: number; onopen: (() => void) | null; onerror: (() => void) | null; addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void; close(): void }`, `interface StreamOptions { url?: string; watchdogMs?: number; makeSource?: (url: string) => SourceLike; random?: () => number }`, `backoffMs(attempt: number, random?: () => number): number`, `openStream(h: StreamHandlers, o?: StreamOptions): () => void`.
  - `homestory.ts`: `homeHeadline(s: StatsMsg | null): Part[]`, `lanesPaused(s: StatsMsg | null): boolean`, `interface LaneShare { lane: string; label: string; ink: string; pct: number }`, `laneShares(s: StatsMsg | null): LaneShare[]`.

- [ ] **Step 1: Write the failing tests**

`packages/explorer/test/pacing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PACING, Pacer } from '../lib/pacing.js';

describe('Pacer', () => {
  it("spreads a block's rows over the expected gap", () => {
    const p = new Pacer<string>();
    p.push(['a', 'b', 'c', 'd', 'e'], 0); // no gaps seen yet: 500 ms
    expect(p.take(0)).toEqual(['a']);
    expect(p.take(99)).toEqual([]);
    expect(p.take(100)).toEqual(['b']);
    expect(p.take(450)).toEqual(['c', 'd', 'e']);
  });

  it('expects the median of the last gaps between blocks, within bounds', () => {
    const p = new Pacer<number>();
    p.push([], 0);
    p.push([], 400);
    p.push([], 1000);
    expect(p.interval()).toBe(500);
    p.push([], 6000);
    expect(p.interval()).toBe(600);
    const q = new Pacer<number>();
    q.push([], 0);
    q.push([], 10);
    expect(q.interval()).toBe(100);
  });

  it('drains a backlog over 3 s within a second instead of falling further behind', () => {
    // every block spread over 2 s: the second one would end 3.8 s out
    const p = new Pacer<number>({ ...PACING, minGapMs: 2000, maxGapMs: 2000, defaultGapMs: 2000 });
    p.push(Array.from({ length: 20 }, (_, j) => j), 0);
    p.push(Array.from({ length: 20 }, (_, j) => 20 + j), 0);
    expect(p.waiting).toBe(40);
    expect(p.take(1000)).toEqual(Array.from({ length: 40 }, (_, j) => j));
  });

  it('holds rows while paused, counts them, and drains them on resume', () => {
    const p = new Pacer<number>();
    p.pause();
    p.push([1, 2, 3], 0);
    expect(p.take(10_000)).toEqual([]);
    expect(p.waiting).toBe(3);
    expect(p.isPaused).toBe(true);
    p.resume(10_000);
    expect(p.take(10_000)).toEqual([1]);
    expect(p.take(11_000)).toEqual([2, 3]);
  });

  it('keeps arrival order across blocks', () => {
    const p = new Pacer<number>();
    p.push([1, 2], 0);
    p.push([3], 100);
    expect(p.take(5000)).toEqual([1, 2, 3]);
  });
});
```

`packages/explorer/test/stream-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, openStream, type SourceLike } from '../lib/stream-client.js';

class FakeSource implements SourceLike {
  static made: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (e: MessageEvent<string>) => void>();
  constructor(readonly url: string) { FakeSource.made.push(this); }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) { this.listeners.set(type, fn); }
  close() { this.closed = true; this.readyState = 2; }
  emit(type: string, data: unknown, id = '') { this.listeners.get(type)!({ data: JSON.stringify(data), lastEventId: id } as MessageEvent<string>); }
}

const handlers = () => ({ hello: vi.fn(), block: vi.fn(), stats: vi.fn(), state: vi.fn() });

describe('openStream', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeSource.made = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('backs off 1 s doubling to 30 s, with jitter', () => {
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(9, () => 0.5)).toBe(30_000);
    expect(backoffMs(0, () => 0)).toBe(750);
  });

  it('delivers messages and reports the stream open', () => {
    const h = handlers();
    openStream(h, { makeSource: (u) => new FakeSource(u) });
    const s = FakeSource.made[0]!;
    expect(s.url).toBe('/api/stream');
    s.onopen!();
    s.emit('block', { n: 7 }, '7');
    expect(h.state).toHaveBeenCalledWith(true);
    expect(h.block).toHaveBeenCalledWith({ n: 7 });
  });

  it('retries a stream the browser gave up on (a 503), resuming from the last id', () => {
    const h = handlers();
    openStream(h, { makeSource: (u) => new FakeSource(u), random: () => 0.5 });
    const s = FakeSource.made[0]!;
    s.emit('block', { n: 41 }, '41');
    s.readyState = 2;
    s.onerror!();
    expect(h.state).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(999);
    expect(FakeSource.made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.made[1]!.url).toBe('/api/stream?last=41');
    FakeSource.made[1]!.readyState = 2;
    FakeSource.made[1]!.onerror!();
    vi.advanceTimersByTime(2000);
    expect(FakeSource.made).toHaveLength(3);
  });

  it('leaves a reconnecting stream to the browser', () => {
    openStream(handlers(), { makeSource: (u) => new FakeSource(u) });
    FakeSource.made[0]!.onerror!(); // readyState CONNECTING: EventSource retries itself
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.made).toHaveLength(1);
  });

  it('reconnects a stream that went silent', () => {
    openStream(handlers(), { makeSource: (u) => new FakeSource(u), watchdogMs: 45_000, random: () => 0.5 });
    const s = FakeSource.made[0]!;
    s.onopen!();
    vi.advanceTimersByTime(45_000);
    expect(s.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeSource.made).toHaveLength(2);
  });

  it('stops for good when closed', () => {
    const stop = openStream(handlers(), { makeSource: (u) => new FakeSource(u) });
    stop();
    expect(FakeSource.made[0]!.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeSource.made).toHaveLength(1);
  });
});
```

Note: the "leaves a reconnecting stream to the browser" case starts a watchdog only after `onopen`, so 60 s of silence before any open must not reconnect. Keep that behaviour: the watchdog is armed on `onopen` and on every message.

`packages/explorer/test/homestory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { homeHeadline, laneShares, lanesPaused } from '../lib/homestory.js';
import type { StatsMsg } from '../lib/types.js';

const S = (over: Partial<StatsMsg>): StatsMsg => ({ count: 161, usdc: '13680.49', perSec: 2.7, lanes: { swap: 123, payment: 30 }, largest: [], now: 0, ...over });

describe('home headline', () => {
  it('writes the minute from live numbers', () => {
    expect(homeHeadline(S({}))).toEqual([
      'In the last minute ', { b: '13,680 USDC' }, ' moved across Arc in ', { b: '161' }, ' movements', '; ', { b: '123' }, ' of them were swaps.',
    ]);
  });
  it('leaves lanes out while they are paused', () => {
    expect(homeHeadline(S({ lanes: { swap: 3 } })).at(-1)).toBe('.');
    expect(lanesPaused(S({ lanes: { swap: 3 } }))).toBe(true);
    expect(lanesPaused(S({}))).toBe(false);
  });
  it('waits for the first numbers', () => {
    expect(homeHeadline(null)).toEqual(['Listening to Arc…']);
    expect(homeHeadline(S({ count: 0, usdc: '0', lanes: {} }))).toEqual(['Listening to Arc…']);
  });
  it('agrees in number', () => {
    expect(homeHeadline(S({ count: 1, lanes: { swap: 1 } }))).toEqual([
      'In the last minute ', { b: '13,680 USDC' }, ' moved across Arc in ', { b: '1' }, ' movement', '; ', { b: '1' }, ' of them was a swap.',
    ]);
  });
});

describe('lane shares', () => {
  it("lists the usual lanes in core's order, and others when present", () => {
    const shares = laneShares(S({ lanes: { swap: 123, payment: 30, uncertain: 8 } }));
    expect(shares.map((s) => s.lane)).toEqual(['swap', 'bridge', 'liquidity', 'vault', 'lending', 'signed_payment', 'payment', 'spam', 'issuance', 'uncertain']);
    expect(shares[0]).toEqual({ lane: 'swap', label: 'Swap', ink: '#7442d1', pct: 76 });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm --filter @arckive/explorer test -- test/pacing.test.ts test/stream-client.test.ts test/homestory.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `lib/pacing.ts`**

```ts
export interface PacerOptions {
  gapsKept: number;
  minGapMs: number;
  maxGapMs: number;
  defaultGapMs: number;
  maxBacklogMs: number;
  drainMs: number;
}

export const PACING: PacerOptions = { gapsKept: 20, minGapMs: 100, maxGapMs: 2000, defaultGapMs: 500, maxBacklogMs: 3000, drainMs: 1000 };

// Spreads each block's rows over the time until the next block is expected
// (the median gap of the last 20, ~0.5 s on Arc), so the tape flows instead
// of jumping. A backlog over 3 s is drained within a second rather than
// delayed further; while paused (the pointer or focus on the tape) nothing
// enters and the rows wait.
export class Pacer<T> {
  #q: Array<{ item: T; due: number }> = [];
  #gaps: number[] = [];
  #last: number | null = null;
  #paused = false;

  constructor(private readonly o: PacerOptions = PACING) {}

  interval(): number {
    if (!this.#gaps.length) return this.o.defaultGapMs;
    const s = [...this.#gaps].sort((a, b) => a - b);
    const mid = s.length >> 1;
    const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    return Math.min(this.o.maxGapMs, Math.max(this.o.minGapMs, median));
  }

  push(items: readonly T[], now: number): void {
    if (this.#last !== null) {
      this.#gaps.push(now - this.#last);
      if (this.#gaps.length > this.o.gapsKept) this.#gaps.shift();
    }
    this.#last = now;
    if (!items.length) return;
    const step = this.interval() / items.length;
    const start = Math.max(now, this.#q.at(-1)?.due ?? now);
    items.forEach((item, i) => this.#q.push({ item, due: start + step * i }));
    if (!this.#paused && this.#q.at(-1)!.due - now > this.o.maxBacklogMs) this.#respread(now);
  }

  #respread(now: number): void {
    const step = this.o.drainMs / this.#q.length;
    this.#q.forEach((e, i) => {
      e.due = now + step * i;
    });
  }

  take(now: number): T[] {
    if (this.#paused) return [];
    let i = 0;
    while (i < this.#q.length && this.#q[i]!.due <= now) i++;
    return this.#q.splice(0, i).map((e) => e.item);
  }

  pause(): void {
    this.#paused = true;
  }

  resume(now: number): void {
    if (!this.#paused) return;
    this.#paused = false;
    if (this.#q.length) this.#respread(now);
  }

  clear(): void {
    this.#q = [];
  }

  get waiting(): number {
    return this.#q.length;
  }

  get isPaused(): boolean {
    return this.#paused;
  }
}
```

Check against the test: five rows pushed at 0 with a 500 ms interval are due at 0, 100, 200, 300, 400; resuming three paused rows at 10,000 spreads them over 1000 ms (10,000, 10,333, 10,667).

- [ ] **Step 4: Implement `lib/stream-client.ts`**

```ts
import type { BlockMsg, Hello, StatsMsg } from './types.js';

export interface StreamHandlers {
  hello(h: Hello): void;
  block(b: BlockMsg): void;
  stats(s: StatsMsg): void;
  state(open: boolean): void;
}

// The parts of EventSource the client uses (injected in tests).
export interface SourceLike {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void;
  close(): void;
}

export interface StreamOptions {
  url?: string;
  watchdogMs?: number;
  makeSource?: (url: string) => SourceLike;
  random?: () => number;
}

const CLOSED = 2;

// For a stream the browser gave up on (a 503 above MAX_STREAMS, a dropped
// connection): 1 s doubling to 30 s, jittered so a restart does not bring
// every viewer back in the same second.
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function openStream(h: StreamHandlers, o: StreamOptions = {}): () => void {
  const url = o.url ?? '/api/stream';
  const make = o.makeSource ?? ((u: string) => new EventSource(u) as unknown as SourceLike);
  const watchdogMs = o.watchdogMs ?? 45_000;
  let source: SourceLike | null = null;
  let last: string | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let dog: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    clearTimeout(retry);
    retry = setTimeout(connect, backoffMs(attempt++, o.random));
  };
  // stats arrive every second: this much silence is a stalled stream (a
  // proxy that stopped forwarding, a server that dropped us as too slow)
  const arm = (): void => {
    clearTimeout(dog);
    dog = setTimeout(() => {
      source?.close();
      source = null;
      h.state(false);
      schedule();
    }, watchdogMs);
  };
  function connect(): void {
    if (stopped) return;
    const s = make(last === null ? url : `${url}?last=${encodeURIComponent(last)}`);
    source = s;
    s.onopen = () => {
      attempt = 0;
      h.state(true);
      arm();
    };
    s.onerror = () => {
      h.state(false);
      // CONNECTING: the browser retries on its own, sending Last-Event-ID
      if (s.readyState === CLOSED && source === s) {
        clearTimeout(dog);
        source = null;
        schedule();
      }
    };
    const on = <T>(type: string, fn: (d: T) => void): void => {
      s.addEventListener(type, (e) => {
        arm();
        if (e.lastEventId) last = e.lastEventId;
        fn(JSON.parse(e.data) as T);
      });
    };
    on<Hello>('hello', h.hello);
    on<BlockMsg>('block', h.block);
    on<StatsMsg>('stats', h.stats);
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(dog);
    source?.close();
    source = null;
  };
}
```

- [ ] **Step 5: Implement `lib/homestory.ts`**

```ts
import { fmtInt, fmtWhole, pct } from './format.js';
import { LANES_ALWAYS, LANE_ORDER, laneMeta } from './lanes.js';
import type { Part } from './parts.js';
import type { StatsMsg } from './types.js';

const laned = (s: StatsMsg): number => Object.values(s.lanes).reduce((a, b) => a + b, 0);

// "Insights down": more than half of the last minute went out without a lane.
export function lanesPaused(s: StatsMsg | null): boolean {
  return !!s && s.count > 0 && laned(s) * 2 < s.count;
}

export function homeHeadline(s: StatsMsg | null): Part[] {
  if (!s || s.count === 0) return ['Listening to Arc…'];
  const parts: Part[] = [
    'In the last minute ', { b: `${fmtWhole(s.usdc)} USDC` }, ' moved across Arc in ', { b: fmtInt(s.count) },
    s.count === 1 ? ' movement' : ' movements',
  ];
  if (lanesPaused(s)) return [...parts, '.'];
  const swaps = s.lanes['swap'] ?? 0;
  return [...parts, '; ', { b: fmtInt(swaps) }, swaps === 1 ? ' of them was a swap.' : ' of them were swaps.'];
}

export interface LaneShare {
  lane: string;
  label: string;
  ink: string;
  pct: number;
}

export function laneShares(s: StatsMsg | null): LaneShare[] {
  const total = s?.count ?? 0;
  return LANE_ORDER.filter((l) => LANES_ALWAYS.includes(l) || (s?.lanes[l] ?? 0) > 0).map((lane) => {
    const m = laneMeta(lane);
    return { lane, label: m.label, ink: m.ink, pct: pct(s?.lanes[lane] ?? 0, total) };
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `corepack pnpm --filter @arckive/explorer test -- test/pacing.test.ts test/stream-client.test.ts test/homestory.test.ts`
Expected: PASS.

- [ ] **Step 7: Write `components/HomeLive.tsx` and the home page**

`packages/explorer/components/HomeLive.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fmtAmount, fmtTime, shortAddr } from '../lib/format.js';
import { homeHeadline, laneShares, lanesPaused } from '../lib/homestory.js';
import { laneMeta } from '../lib/lanes.js';
import { liveState } from '../lib/live.js';
import { Pacer } from '../lib/pacing.js';
import { openStream } from '../lib/stream-client.js';
import type { BlockMsg, Hello, Move, StatsMsg } from '../lib/types.js';
import { Dateline } from './Dateline.js';
import { LaneTag } from './LaneTag.js';
import { Masthead } from './Masthead.js';
import { Parts } from './Parts.js';
import { Status } from './Status.js';

const TAPE_ROWS = 32;

interface Row extends Move {
  key: string;
  n: number;
  t: number;
}

const rowsOf = (b: BlockMsg): Row[] => b.moves.map((m) => ({ ...m, key: `${b.n}:${m.li}`, n: b.n, t: b.t }));
// newest first, as the tape shows them
const newestFirst = (blocks: BlockMsg[]): Row[] => blocks.flatMap(rowsOf).reverse().slice(0, TAPE_ROWS);

// Rows are links already: names here are text, not nested links.
function Who({ address, name }: { address: string; name?: string }) {
  return name ? <b>{name}</b> : <>{shortAddr(address)}</>;
}

export function HomeLive({ initial, date }: { initial: Hello; date: string }) {
  const [rows, setRows] = useState<Row[]>(() => newestFirst(initial.blocks));
  const [stats, setStats] = useState<StatsMsg | null>(initial.stats);
  const [open, setOpen] = useState(true);
  const [waiting, setWaiting] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const pacer = useRef(new Pacer<Row>());
  const offset = useRef(0); // server clock − browser clock
  const newest = useRef<{ n: number; t: number } | null>(initial.blocks.at(-1) ?? null);

  useEffect(() => {
    const stop = openStream({
      hello: (h) => {
        pacer.current.clear();
        setRows(newestFirst(h.blocks));
        newest.current = h.blocks.at(-1) ?? newest.current;
        if (h.stats) setStats(h.stats);
      },
      block: (b) => {
        // a resumed stream never repeats a block, but a hello may overlap the buffer
        if (newest.current && b.n <= newest.current.n) return;
        newest.current = { n: b.n, t: b.t };
        pacer.current.push(rowsOf(b), performance.now());
      },
      stats: (s) => {
        offset.current = s.now - Date.now();
        setStats(s);
      },
      state: setOpen,
    });
    let raf = 0;
    const tick = (): void => {
      const due = pacer.current.take(performance.now());
      if (due.length) setRows((cur) => [...due.reverse(), ...cur].slice(0, TAPE_ROWS));
      setWaiting(pacer.current.isPaused ? pacer.current.waiting : 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop();
      cancelAnimationFrame(raf);
      clearInterval(clock);
    };
  }, []);

  // The newest block received, not the newest shown: a viewer hovering the
  // tape has paused it, the network has not fallen behind.
  const state = liveState(newest.current?.t ?? null, now + offset.current, open);
  const pause = (): void => pacer.current.pause();
  const resume = (): void => pacer.current.resume(performance.now());
  const paused = lanesPaused(stats);

  return (
    <>
      <Masthead status={<Status state={state} />} />
      <Dateline date={date} />
      <div className="head">
        <h1>
          <Parts parts={homeHeadline(stats)} />
        </h1>
        <p className="fig">Fig. 1 — the tape below is every USDC movement as it lands, each filed under the lane Laya read in its transaction.</p>
      </div>
      <div className="cols home">
        <section aria-label="The tape">
          <h2>
            The tape{' '}
            <span>
              {waiting > 0 && <span className="waiting">{waiting} new</span>} {stats ? `${stats.perSec.toFixed(1)} a second · UTC` : 'UTC'}
            </span>
          </h2>
          <div
            className="tape"
            onMouseEnter={pause}
            onMouseLeave={resume}
            onFocus={pause}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume();
            }}
          >
            {rows.map((r) => (
              <Link key={r.key} href={`/tx/${r.tx}`} prefetch={false} className="row" style={{ '--lane': laneMeta(r.lane).ink } as CSSProperties}>
                <span className="time">{fmtTime(r.t)}</span>
                <LaneTag lane={r.lane} />
                <span className="who">
                  <Who address={r.from} name={r.fromName} /> → <Who address={r.to} name={r.toName} />
                </span>
                <span className="amt">
                  {fmtAmount(r.value)}
                  <small>USDC</small>
                </span>
              </Link>
            ))}
          </div>
        </section>
        <aside>
          <h2>Largest this minute</h2>
          <div className="largest">
            {(stats?.largest ?? []).map((m) => (
              <Link key={`${m.n}:${m.li}`} href={`/tx/${m.tx}`} prefetch={false}>
                <span className="n">{fmtAmount(m.value)}</span>
                <LaneTag lane={m.lane} />
                <span className="s">
                  <Who address={m.from} name={m.fromName} /> → <Who address={m.to} name={m.toName} />
                </span>
              </Link>
            ))}
          </div>
          <div className="lanes">
            <h2>
              By lane <span>{paused ? 'lanes paused' : 'share of movements'}</span>
            </h2>
            {laneShares(stats).map((s) => (
              <div className="bar" key={s.lane}>
                <span>{s.label}</span>
                <span className="track">
                  <span style={{ width: `${s.pct}%`, background: s.ink }} />
                </span>
                <em>{s.pct}%</em>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
```

`packages/explorer/app/page.tsx`:

```tsx
import { HomeLive } from '../components/HomeLive.js';
import { fmtDateLong } from '../lib/format.js';
import { getRuntime } from '../lib/runtime.js';
import type { Hello } from '../lib/types.js';

export const dynamic = 'force-dynamic';

// Rendered with the tailer's latest movements so the first paint already
// shows the tape; the stream takes over in the browser.
export default function Home() {
  let initial: Hello = { blocks: [], stats: null };
  try {
    initial = getRuntime().hub.hello();
  } catch {
    // no runtime yet: the stream fills the tape on its own
  }
  return <HomeLive initial={initial} date={fmtDateLong(new Date())} />;
}
```

- [ ] **Step 8: Build, lint, test, commit**

```bash
NEXT_TELEMETRY_DISABLED=1 corepack pnpm --filter @arckive/explorer build
corepack pnpm lint
corepack pnpm --filter @arckive/explorer test
git add packages/explorer
git commit -m "feat(explorer): live tape home page — paced rows, hover pause, headline, largest, by lane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 12: The transaction page

**Files:**
- Create: `packages/explorer/app/tx/[hash]/page.tsx`, `app/tx/[hash]/not-found.tsx`, `components/Flow.tsx`, `components/SwapBox.tsx`, `components/LanePanel.tsx`
- Test: none new (the data and sentences are tested in Tasks 5–6; the page is checked by build here and by the browser smoke in Task 15)

**Interfaces:**
- Consumes: `readyRuntime`, `getRuntime` (Task 9); `loadTx`, `loadLane`, `laneOrder` (Task 5); `txHeadline`, `txPath`, `swapView`, `flowView`, `eventRows`, `txFacts`, `legsLabel`, `tokenAddresses` (Task 6); `parseTxHash` (Task 2); `liveState` (Task 10); components from Task 10; `LaneState` (Task 2).

- [ ] **Step 1: Write the components**

`packages/explorer/components/Flow.tsx`:

```tsx
import Link from 'next/link';
import { Fragment } from 'react';
import { shortAddr } from '../lib/format.js';
import { nameOf } from '../lib/names.js';
import type { FlowView } from '../lib/txstory.js';

export function Flow({ flow }: { flow: FlowView }) {
  return (
    <div className="flow">
      {flow.nodes.map((node, i) => {
        const name = nameOf(node.address);
        const edge = flow.edges[i];
        return (
          <Fragment key={i}>
            <Link href={`/address/${node.address}`} className="node" title={node.address} prefetch={false}>
              <span className="k">{node.role}</span>
              <span className={name ? 'v named' : 'v'}>{name ?? shortAddr(node.address)}</span>
            </Link>
            {edge && (
              <div className="edge">
                <span className="amt">
                  {edge.amount}
                  <small>USDC</small>
                </span>
                <span className="line" />
                <span className="log">log #{edge.li}</span>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
```

`packages/explorer/components/SwapBox.tsx`:

```tsx
import { shortHash } from '../lib/format.js';
import type { SwapView } from '../lib/txstory.js';

export function SwapBox({ view }: { view: SwapView }) {
  if (!view.known) {
    return <p className="fig">A swap in pool {shortHash(view.pool)}, whose creation is not in the archive: its currencies are unknown.</p>;
  }
  return (
    <div className="swapbox">
      <div className="side">
        <div className="k">Paid into pool</div>
        <div className="n">{view.paid?.amount ?? '—'}</div>
        <div className="t">{view.paid?.token ?? ''}</div>
      </div>
      <div className="arrow" aria-hidden="true">
        ⇄
      </div>
      <div className="side right">
        <div className="k">Received from pool</div>
        <div className="n">{view.received?.amount ?? '—'}</div>
        <div className="t">
          {view.received?.token ?? ''} · pool fee {view.fee}
        </div>
      </div>
    </div>
  );
}
```

`packages/explorer/components/LanePanel.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { dayOf, fmtDay } from '../lib/format.js';
import type { LaneState } from '../lib/types.js';
import { LaneTag } from './LaneTag.js';

const POLL_MS = 2000;
const POLLS = 15; // 30 s

export function LanePanel({ hash, initial }: { hash: string; initial: LaneState }) {
  const [lane, setLane] = useState(initial);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (lane.kind !== 'pending') return;
    let polls = 0;
    const id = setInterval(async () => {
      polls++;
      try {
        const r = await fetch(`/api/tx/${hash}/lane`, { cache: 'no-store' });
        if (r.ok) {
          const next = ((await r.json()) as { lane: LaneState }).lane;
          if (next.kind !== 'pending') {
            setLane(next);
            clearInterval(id);
            return;
          }
        }
      } catch {
        // the next poll tries again
      }
      if (polls >= POLLS) {
        clearInterval(id);
        setGaveUp(true);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [hash, lane.kind]);

  switch (lane.kind) {
    case 'read':
      return (
        <div>
          <LaneTag lane={lane.lane} /> <span className="conf">· {lane.p === null ? 'ruled' : lane.p.toFixed(2)}</span>
          <p className="why">
            {lane.why} <em>Laya read: “{lane.sentence}”</em>
          </p>
        </div>
      );
    case 'pending':
      return <p className="why">{gaveUp ? 'Laya has not read this transaction yet; reload in a while.' : 'Laya is reading this transaction…'}</p>;
    case 'before':
      return <p className="why">Arckive began reading lanes on {fmtDay(dayOf(lane.since))}; this transaction is older.</p>;
    case 'none':
      return <p className="why">Laya has no lane for this transaction.</p>;
    case 'off':
      return <p className="why">Lanes are not being read on this archive yet.</p>;
  }
}
```

- [ ] **Step 2: Write the page and its 404**

`packages/explorer/app/tx/[hash]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Addr } from '../../../components/Addr.js';
import { Dateline } from '../../../components/Dateline.js';
import { Flow } from '../../../components/Flow.js';
import { LanePanel } from '../../../components/LanePanel.js';
import { LaneTag } from '../../../components/LaneTag.js';
import { Masthead } from '../../../components/Masthead.js';
import { Parts } from '../../../components/Parts.js';
import { Status } from '../../../components/Status.js';
import { SwapBox } from '../../../components/SwapBox.js';
import { fmtDateLong, fmtDateTime, fmtInt, shortHash } from '../../../lib/format.js';
import { liveState } from '../../../lib/live.js';
import { readyRuntime } from '../../../lib/runtime.js';
import { decodeParam, parseTxHash } from '../../../lib/search.js';
import { laneOrder, loadLane, loadTx } from '../../../lib/tx.js';
import {
  eventRows, flowView, legsLabel, swapView, tokenAddresses, txFacts, txHeadline, txPath, type EventRow,
} from '../../../lib/txstory.js';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ hash: string }> };

// event kinds borrow a lane's ink
const KIND_INK: Record<EventRow['kind'], string> = {
  Transfer: 'payment', Swap: 'swap', Liquidity: 'liquidity', Donate: 'vault', Initialize: 'issuance',
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const hash = parseTxHash(decodeParam((await params).hash));
  return { title: hash ? `Transaction ${shortHash(hash)} · Arckive Explorer` : 'Arckive Explorer' };
}

export default async function TxPage({ params }: Props) {
  const hash = parseTxHash(decodeParam((await params).hash));
  if (!hash) notFound();
  const rt = readyRuntime();
  const tx = await loadTx(rt.pool, rt.t, hash);
  if (!tx) notFound();
  const [tokens, lane] = await Promise.all([
    rt.tokens.get(tokenAddresses(tx)),
    loadLane(rt.pool, rt.t, rt.insights, tx.block, laneOrder(tx)),
  ]);
  const flow = flowView(tx.transfers);
  const facts = txFacts(tx);
  return (
    <>
      <Masthead query={hash} status={<Status state={liveState(rt.head?.time ?? null, Date.now())} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <nav className="crumb">
        <Link href="/">The tape</Link> &nbsp;›&nbsp; Transaction
      </nav>
      <h1>
        <Parts parts={txHeadline(tx)} />
      </h1>
      <p className="sub">
        <Parts parts={txPath(tx, tokens)} />
      </p>
      <div className="cols">
        <section>
          {tx.transfers.length > 0 && (
            <>
              <h2>
                How the money moved <span>{legsLabel(tx)}</span>
              </h2>
              {flow && <Flow flow={flow} />}
              <p className="fig">
                Fig. 1 — every USDC movement in this transaction, in log order. Arckive indexes USDC and Uniswap v4 events only; gas and other tokens are not shown.
              </p>
            </>
          )}
          {tx.swaps.map((s) => (
            <SwapBox key={s.li} view={swapView(s, tx.pools[s.pool], tokens)} />
          ))}
          <h2 className="gap">
            Events in this transaction <span>as logged on chain</span>
          </h2>
          <div className="events">
            {eventRows(tx).map((e) => (
              <div className="ev" key={e.li}>
                <span className="li">#{e.li}</span>
                <LaneTag lane={KIND_INK[e.kind]} label={e.kind} />
                <span className="who">
                  <Parts parts={e.parts} />
                </span>
                <span className="a">{e.amount ?? ''}</span>
              </div>
            ))}
          </div>
        </section>
        <aside>
          <h2>Lane</h2>
          <LanePanel hash={hash} initial={lane} />
          <h2 className="gap">Facts</h2>
          <dl className="facts">
            <dt>Transaction</dt>
            <dd>{tx.hash}</dd>
            <dt>Block</dt>
            <dd>{fmtInt(tx.block)}</dd>
            <dt>Time</dt>
            <dd>{fmtDateTime(tx.time)}</dd>
            <dt>Protocol</dt>
            <dd>{facts.protocol}</dd>
            {facts.pool && (
              <>
                <dt>Pool</dt>
                <dd>{facts.pool}</dd>
              </>
            )}
            {facts.parties.length > 0 && (
              <>
                <dt>Parties</dt>
                <dd className="parties">
                  {facts.parties.map((a) => (
                    <Addr key={a} address={a} full />
                  ))}
                </dd>
              </>
            )}
          </dl>
        </aside>
      </div>
    </>
  );
}
```

`packages/explorer/app/tx/[hash]/not-found.tsx`:

```tsx
import Link from 'next/link';
import { Dateline } from '../../../components/Dateline.js';
import { Masthead } from '../../../components/Masthead.js';
import { Status } from '../../../components/Status.js';
import { fmtDateLong } from '../../../lib/format.js';

export default function TxNotFound() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <main className="empty">
        <nav className="crumb">
          <Link href="/">The tape</Link> &nbsp;›&nbsp; Transaction
        </nav>
        <h1>Arckive has no USDC or Uniswap v4 event in this transaction.</h1>
        <p className="sub">It may be newer than the archive, or it moved neither USDC nor a Uniswap v4 pool. Search another transaction hash or an address above.</p>
      </main>
    </>
  );
}
```

- [ ] **Step 3: Build, lint, commit**

```bash
NEXT_TELEMETRY_DISABLED=1 corepack pnpm --filter @arckive/explorer build
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): transaction page — headline, money flow, swap box, events, lane, facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 13: The address page

**Files:**
- Create: `packages/explorer/app/address/[address]/page.tsx`, `app/address/[address]/not-found.tsx`, `components/DayChart.tsx`
- Test: none new (data and sentences tested in Task 7; page checked by build and by Task 15)

**Interfaces:**
- Consumes: `readyRuntime` (Task 9); `addressId`, `totals`, `days`, `history`, `recent`, `parseBefore` (Task 7); `addressHeadline`, `topLane`, `netOf`, `chartBars` (Task 7); `parseAddress` (Task 2); components from Task 10.

- [ ] **Step 1: Write the chart**

`packages/explorer/components/DayChart.tsx`:

```tsx
import { chartBars } from '../lib/addrstory.js';
import type { DayBar } from '../lib/address.js';

const W = 840;
const H = 190;
const MID = 100;
const HALF = 82;

// USDC in above the line, out below, one bar per UTC day over the whole history.
export function DayChart({ days }: { days: DayBar[] }) {
  const { bars, barWidth } = chartBars(days, W, HALF);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="USDC received and sent per day">
      <line x1="0" x2={W} y1={MID} y2={MID} stroke="#15171b" strokeWidth="1" />
      {bars.map((b) => (
        <g key={b.day}>
          <title>{b.day}</title>
          {b.inH > 0 && <rect x={b.x} y={MID - b.inH} width={barWidth} height={b.inH} fill="#1d8a57" />}
          {b.outH > 0 && <rect x={b.x} y={MID + 1} width={barWidth} height={b.outH} fill="#b2412f" opacity=".85" />}
        </g>
      ))}
      <text x="0" y="12">in</text>
      <text x="0" y={H - 4}>out</text>
    </svg>
  );
}
```

- [ ] **Step 2: Write the page and its 404**

`packages/explorer/app/address/[address]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Addr } from '../../../components/Addr.js';
import { Dateline } from '../../../components/Dateline.js';
import { DayChart } from '../../../components/DayChart.js';
import { LaneTag } from '../../../components/LaneTag.js';
import { Masthead } from '../../../components/Masthead.js';
import { Parts } from '../../../components/Parts.js';
import { Status } from '../../../components/Status.js';
import { addressId, days, history, parseBefore, recent, totals } from '../../../lib/address.js';
import { addressHeadline, netOf, topLane } from '../../../lib/addrstory.js';
import {
  fmtAmount, fmtDateLong, fmtDay, fmtInt, fmtSigned, fmtStamp, pct, shortAddr, unitsToDecimal,
} from '../../../lib/format.js';
import { LANE_ORDER, laneMeta } from '../../../lib/lanes.js';
import { liveState } from '../../../lib/live.js';
import { readyRuntime } from '../../../lib/runtime.js';
import { decodeParam, parseAddress } from '../../../lib/search.js';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The rollup lags the worker by up to a round (2 s) in steady state; further
// behind, the totals say how far they reach.
const ROLLUP_SLACK = 120;

const usdc = (raw: string): string => fmtAmount(unitsToDecimal(raw));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = parseAddress(decodeParam((await params).address));
  return { title: address ? `Address ${shortAddr(address)} · Arckive Explorer` : 'Arckive Explorer' };
}

export default async function AddressPage({ params, searchParams }: Props) {
  const address = parseAddress(decodeParam((await params).address));
  if (!address) notFound();
  const sp = await searchParams;
  const before = parseBefore(typeof sp['before'] === 'string' ? sp['before'] : undefined);
  const rt = readyRuntime();
  const id = await addressId(rt.pool, rt.t, address);
  const tot = id === null ? null : await totals(rt.pool, id);
  const shell = (
    <>
      <Masthead query={address} status={<Status state={liveState(rt.head?.time ?? null, Date.now())} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <nav className="crumb">
        <Link href="/">The tape</Link> &nbsp;›&nbsp; Address
      </nav>
      <h1>
        <span className="mono">{address}</span>
      </h1>
    </>
  );
  if (id === null || !tot || tot.inCount + tot.outCount === 0) {
    return (
      <>
        {shell}
        <main className="empty">
          <p className="sub">No USDC movement for this address since 2026-05-15.</p>
        </main>
      </>
    );
  }
  const lanesOn = rt.insights.on;
  const [dayRows, page, rec] = await Promise.all([
    days(rt.pool, id),
    history(rt.pool, rt.t, lanesOn, id, before),
    recent(rt.pool, rt.t, lanesOn, id),
  ]);
  const behind = rt.rolledTo !== null && rt.head !== null && rt.rolledTo < rt.head.block - ROLLUP_SLACK;
  const laneTotal = Object.values(rec.lanes).reduce((a, b) => a + b, 0);
  return (
    <>
      {shell}
      <p className="sub">
        <Parts parts={addressHeadline({ address, totals: tot, topLane: topLane(rec.lanes) })} />
      </p>
      {behind && <p className="note">Totals up to block {fmtInt(rt.rolledTo!)}; later movements are still being added.</p>}
      <div className="stats">
        <div>
          <div className="k">Received · USDC</div>
          <div className="n in">{usdc(tot.inValue)}</div>
        </div>
        <div>
          <div className="k">Sent · USDC</div>
          <div className="n out">{usdc(tot.outValue)}</div>
        </div>
        <div>
          <div className="k">Net · USDC</div>
          <div className="n">{fmtSigned(netOf(tot))}</div>
        </div>
        <div>
          <div className="k">Movements</div>
          <div className="n">{fmtInt(tot.inCount + tot.outCount)}</div>
        </div>
      </div>
      <div className="cols">
        <section>
          <h2>
            In and out, day by day{' '}
            <span>
              {tot.firstDay && tot.lastDay ? `${fmtDay(tot.firstDay)} – ${fmtDay(tot.lastDay)} · UTC` : 'UTC'}
            </span>
          </h2>
          <DayChart days={dayRows} />
          <p className="fig">Fig. 1 — USDC received (above the line) and sent (below) per day, over this address’s whole history.</p>
          <h2 className="gap">
            History <span>{before ? 'older movements, newest first · UTC' : 'newest first · UTC'}</span>
          </h2>
          <div className="hist">
            {page.rows.map((r) => (
              <div className="hrow" key={`${r.block}-${r.li}`}>
                <span className="t">{fmtStamp(r.time)}</span>
                <span className={`dir ${r.dir}`}>{r.dir.toUpperCase()}</span>
                <span className="who">
                  {r.dir === 'self' ? 'to itself' : <>{r.dir === 'in' ? 'from ' : 'to '}<Addr address={r.counterparty} /></>}
                </span>
                <LaneTag lane={r.lane} />
                <span className="a">{usdc(r.value)}</span>
                <Link className="x" href={`/tx/${r.tx}`} prefetch={false}>
                  {r.tx.slice(0, 10)}…
                </Link>
              </div>
            ))}
          </div>
          <nav className="more">
            {before && <Link href={`/address/${address}`} prefetch={false}>← Newest</Link>}
            {page.older && <Link href={`/address/${address}?before=${page.older}`} prefetch={false}>Older movements →</Link>}
          </nav>
        </section>
        <aside>
          <h2>
            Most frequent counterparties <span>latest {fmtInt(rec.total)}</span>
          </h2>
          <div className="cp">
            {rec.counterparties.map((c) => (
              <div className="cpr" key={c.address}>
                <span className="w">
                  <Addr address={c.address} />
                </span>
                <span className="n">{usdc(c.value)}</span>
                <span className="s">
                  {fmtInt(c.count)} {c.count === 1 ? 'movement' : 'movements'}
                </span>
              </div>
            ))}
          </div>
          <div className="lanes">
            <h2>
              By lane <span>latest {fmtInt(rec.total)} movements</span>
            </h2>
            {laneTotal === 0 ? (
              <p className="fig">No lanes read for these movements yet.</p>
            ) : (
              LANE_ORDER.filter((l) => (rec.lanes[l] ?? 0) > 0).map((l) => (
                <div className="bar" key={l}>
                  <span>{laneMeta(l).label}</span>
                  <span className="track">
                    <span style={{ width: `${pct(rec.lanes[l]!, rec.total)}%`, background: laneMeta(l).ink }} />
                  </span>
                  <em>{pct(rec.lanes[l]!, rec.total)}%</em>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
```

`packages/explorer/app/address/[address]/not-found.tsx`:

```tsx
import Link from 'next/link';
import { Dateline } from '../../../components/Dateline.js';
import { Masthead } from '../../../components/Masthead.js';
import { Status } from '../../../components/Status.js';
import { fmtDateLong } from '../../../lib/format.js';

export default function AddressNotFound() {
  return (
    <>
      <Masthead status={<Status state={null} />} />
      <Dateline date={fmtDateLong(new Date())} />
      <main className="empty">
        <nav className="crumb">
          <Link href="/">The tape</Link> &nbsp;›&nbsp; Address
        </nav>
        <h1>That is not an address.</h1>
        <p className="sub">An address is 0x followed by 40 hexadecimal characters. Search one, or a transaction hash, above.</p>
      </main>
    </>
  );
}
```

- [ ] **Step 3: Build, lint, commit**

```bash
NEXT_TELEMETRY_DISABLED=1 corepack pnpm --filter @arckive/explorer build
corepack pnpm lint
git add packages/explorer
git commit -m "feat(explorer): address page — whole-history totals, daily chart, keyset history, counterparties

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 14: Image, manifest and documentation

**Files:**
- Modify: `Dockerfile`, `CLAUDE.md`, `README.md`
- Create: `.dockerignore`, `manifests/arc-mainnet/k8s/explorer-app.yaml`

**Interfaces:**
- Consumes: the built package (Tasks 1–13), `/api/health` (Task 9).
- Produces: Docker target `explorer` (`node packages/explorer/server.js` on port 3000), image tag `arckive-explorer:dev` for k3d; Deployment/Service `explorer` reading Secret `explorer-dsn` key `url`.

- [ ] **Step 1: Add the explorer target to the Dockerfile**

Replace `Dockerfile` with:

```dockerfile
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/worker/package.json packages/worker/
COPY packages/operator/package.json packages/operator/
COPY packages/explorer/package.json packages/explorer/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter @arckive/core --filter @arckive/worker --filter @arckive/operator build \
  && pnpm --filter @arckive/worker deploy --legacy --prod /out/worker \
  && pnpm --filter @arckive/operator deploy --legacy --prod /out/operator

# The explorer builds in a stage of its own, so a worker or operator image
# never waits on `next build` (BuildKit skips stages a target does not need).
FROM build AS explorer-build
RUN pnpm --filter @arckive/explorer build

FROM node:22-slim AS worker
WORKDIR /app
COPY --from=build /out/worker .
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

FROM node:22-slim AS operator
WORKDIR /app
COPY --from=build /out/operator .
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

# next build's standalone output: server.js and only the files it traced.
FROM node:22-slim AS explorer
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=explorer-build /app/packages/explorer/.next/standalone ./
COPY --from=explorer-build /app/packages/explorer/.next/static ./packages/explorer/.next/static
USER node
EXPOSE 3000
CMD ["node", "packages/explorer/server.js"]
```

Create `.dockerignore` (the build context no longer carries local `node_modules`, builds or the git history):

```
**/node_modules
**/dist
**/.next
**/*.tsbuildinfo
.git
.superpowers
packages/explorer/smoke/screenshots
packages/explorer/test-results
```

- [ ] **Step 2: Build the images**

Run: `docker build --target explorer -t arckive-explorer:dev .`
Expected: success; `next build` runs inside `explorer-build`.

Run: `docker build --target worker -t arckive-worker:check .`
Expected: success, and the log shows no `explorer-build` step.

Run (the image starts and answers without a database):

```bash
docker run -d --name explorer-check -p 3998:3000 -e DATABASE_URL=postgres://x:y@127.0.0.1:1/x arckive-explorer:dev
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' localhost:3998/            # 200: the shell renders
curl -s -o /dev/null -w '%{http_code}\n' localhost:3998/api/health  # 503: not ready
docker logs explorer-check 2>&1 | grep -c 'database not answering'  # >= 1, no password in the line
docker rm -f explorer-check
docker run --rm arckive-explorer:dev 2>&1 | grep 'arckive-explorer: explorer configuration: DATABASE_URL is required'
```

- [ ] **Step 3: Write the k3d manifest**

`manifests/arc-mainnet/k8s/explorer-app.yaml`:

```yaml
# The explorer: one replica — its tailer and rollup job run in-process (a
# second replica would tail too; the rollup's advisory lock keeps one writer).
# It reads idx_arc_explorer as the role from explorer-role.sql. The DSN
# Secret is created by hand, never committed:
#   kubectl create secret generic explorer-dsn \
#     --from-literal=url=postgres://explorer:<password>@pg-explorer:5432/explorer
# The image is built locally and imported:
#   docker build --target explorer -t arckive-explorer:dev . && k3d image import arckive-explorer:dev -c arckive
# Publishing it (a tunnel or host for a public hostname) is a separate step.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: explorer
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: explorer }
  template:
    metadata:
      labels: { app: explorer }
    spec:
      containers:
        - name: explorer
          image: arckive-explorer:dev
          imagePullPolicy: IfNotPresent
          env:
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: explorer-dsn, key: url } }
            - { name: ARCKIVE_SCHEMA, value: idx_arc_explorer }
          ports: [{ containerPort: 3000 }]
          # Serving, not "database up": while the database is down the pages
          # themselves say so, which a removed endpoint could not.
          readinessProbe:
            tcpSocket: { port: 3000 }
            periodSeconds: 5
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: explorer
spec:
  selector: { app: explorer }
  ports: [{ port: 80, targetPort: 3000 }]
```

- [ ] **Step 4: Document it**

In `CLAUDE.md`, add a row to the repository layout table after `packages/worker`:

```markdown
| `packages/explorer` | `@arckive/explorer` — the Arckive Explorer: a Next.js 15 app (standalone) over the explorer Indexer's schema (`manifests/arc-mainnet/k8s/explorer.yaml`): live tape home page over SSE, transaction and address pages, search. Reads the worker's schema as a read-only role and owns schema `explorer`. Depends on `@arckive/core` only. |
```

Change the sentence under the table to:

```markdown
Dependency direction is strictly `operator → core`, `worker → core` and
`explorer → core`. The operator, the worker and the explorer never import
each other (the explorer's test fixture builds its schema with core's DDL).
```

Add to the Commands block:

```bash
pnpm --filter @arckive/explorer dev     # the explorer on :3000 (needs DATABASE_URL, see its section below)
pnpm --filter @arckive/explorer test    # its unit + database tests (Docker)
pnpm --filter @arckive/explorer smoke   # local browser smoke (after `build`; `pnpm exec playwright install chromium` once)
```

Add a section before `## CI/CD`:

```markdown
### Explorer (`packages/explorer`)

- **One process, two jobs.** `instrumentation.ts` starts the runtime
  (`lib/runtime.ts`) once per process and keeps it on `globalThis`: Next
  bundles instrumentation and each route separately, so a module-level
  singleton would exist per bundle. The **tailer** (`lib/tailer.ts`, every
  250 ms) releases blocks up to the insights cursor, or once their
  `_ingested_at` is older than `LANE_HOLD_MS` (8 s) — never past `_cursor`
  (`lib/release.ts`) — and publishes one `block` message per block to the
  hub; with no `_insights` tables (lanes not switched on) it releases at once
  and never names them in SQL. The **rollup** (`lib/rollup.ts`) folds
  `usdc_transfer` into `explorer.address_daily` (rows and `rollup_cursor` in
  one transaction; a transaction-scoped advisory lock keeps one writer; a
  statement timeout halves the range). Address pages read totals from it,
  never by scanning transfers.
- **Database access** is the role from `manifests/arc-mainnet/k8s/explorer-role.sql`:
  `SELECT` on the worker's schema (default privileges cover tables added
  later), owner of schema `explorer`, `statement_timeout` 5 s. The explorer
  never writes to the worker's schema.
- **Client-safe modules**: client components import only `lib/format`,
  `lanes`, `names`, `search`, `types`, `parts`, `pacing`, `stream-client`,
  `homestory`, `live` and the components without database access — never
  `pg`, `@arckive/core` or `lib/runtime`. Lane order and wording come from
  core's `LANES`; `test/lanes.test.ts` holds `lib/lanes.ts` to it.
- **Amounts never pass through a float**: integer strings → `unitsToDecimal`
  → `fmtAmount`. Select dates as `::text` (pg parses `date` into local
  time) and block times as epoch seconds.
- **Names** (`lib/names.ts`) are only contracts verified on Arc's explorer
  (Blockscout at explorer.arc.io); an address is never called a wallet or a
  contract otherwise.
- **SSE** (`/api/stream`): `hello` (the latest 40 movements + stats), `block`
  (`id:` = block number), `stats` every second, a comment heartbeat every
  15 s; a viewer whose queue fills is dropped and its client reconnects
  (watchdog 45 s, backoff 1 s → 30 s, `?last=`); beyond `MAX_STREAMS` the
  route answers 503.
- Tests build the schema with core's DDL in PostgreSQL 17
  (`test/fixture/`, around the real mainnet swap 0x9a83…015a); files under
  `test/fixture/` and `smoke/` import each other with `.ts` because
  `smoke/serve.ts` runs them under Node's type stripping.
```

In `README.md`, add a section before `## Development`:

```markdown
## Explorer

`packages/explorer` is the Arckive Explorer: native USDC and the Uniswap v4
PoolManager on Arc mainnet, read from an Indexer's own tables
(`manifests/arc-mainnet/k8s/explorer.yaml`). The home page is a live tape
of every USDC movement as it lands (Server-Sent Events from one database
tailer per process); every row opens a transaction page (who paid whom, the
swap's two sides, the lane Laya read), and every address has a page over its
whole history (daily totals folded by the explorer itself).

| Env | Default | |
|---|---|---|
| `DATABASE_URL` | — | the `explorer` role's DSN (`manifests/arc-mainnet/k8s/explorer-role.sql`) |
| `ARCKIVE_SCHEMA` | `idx_arc_explorer` | the Indexer's schema |
| `USDC_TABLE` / `POOL_TABLE_PREFIX` | `usdc_transfer` / `poolmanager_` | its tables |
| `ARC_RPC` | `https://rpc.mainnet.arc.io` | pool tokens' `symbol()` / `decimals()`, read once |
| `LANE_HOLD_MS` | `8000` | how long a row waits for its lane |
| `MAX_STREAMS` | `2000` | open live streams per process |

Run it against a database with `pnpm --filter @arckive/explorer dev`, or
build the image with `docker build --target explorer -t arckive-explorer:dev .`
and apply `manifests/arc-mainnet/k8s/explorer-app.yaml`.
```

- [ ] **Step 5: Run everything and commit**

```bash
corepack pnpm lint && corepack pnpm -r build && corepack pnpm -r test
git add Dockerfile .dockerignore manifests/arc-mainnet/k8s/explorer-app.yaml CLAUDE.md README.md
git commit -m "feat(explorer): Docker target, k3d manifest and documentation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 15: Browser smoke (local, not CI)

**Files:**
- Create: `packages/explorer/smoke/playwright.config.ts`, `smoke/serve.ts`, `smoke/feed.ts`, `smoke/smoke.spec.ts`

**Interfaces:**
- Consumes: `startDb` and rows (Task 3), `partitionDdl` from `@arckive/core` (built `dist`), the built explorer (`next build`).
- Produces: `pnpm --filter @arckive/explorer smoke` → screenshots in `packages/explorer/smoke/screenshots/` (git-ignored) for the PR.

- [ ] **Step 1: Write the feed**

`packages/explorer/smoke/feed.ts`:

```ts
// Writes one block every 500 ms the way the worker does — _blocks, transfers,
// their lanes, then both cursors in one transaction — so the real tailer has
// a tape to release. Relative imports carry .ts (Node's type stripping).
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { partitionDdl } from '@arckive/core';
import * as R from '../test/fixture/rows.ts';

const S = `"${R.SCHEMA}"`;
const PARTIES = [R.POOLMANAGER, R.ROUTER, R.PAYER, R.PAYEE, R.BUSY, ...R.CPS, R.SWAP_PAYER];
const LANES = ['swap', 'swap', 'payment', 'payment', 'signed_payment', 'bridge'];
const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export function startFeed(admin: pg.Pool, everyMs = 500): () => void {
  let n = R.CURSOR;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const made = new Set<string>();
  const ids = new Map<string, number>();
  const labels = new Map<string, number>();

  const idOf = async (c: pg.PoolClient, a: string): Promise<number> => {
    if (!ids.has(a)) {
      const r = await c.query<{ id: number }>(`SELECT id FROM ${S}._addresses WHERE address = $1`, [bytes(a)]);
      ids.set(a, r.rows[0]!.id);
    }
    return ids.get(a)!;
  };
  const labelOf = async (c: pg.PoolClient, lane: string): Promise<number> => {
    if (!labels.has(lane)) {
      const s = await c.query<{ id: number }>(
        `INSERT INTO ${S}._sentences (sentence, model) VALUES ($1, 'laya') ON CONFLICT (sentence, model) DO UPDATE SET sentence = excluded.sentence RETURNING id`,
        [`smoke ${lane}`],
      );
      const l = await c.query<{ id: number }>(
        `INSERT INTO ${S}._labels (lane, lane_p, ruled, protocol, facts, sentence_id) VALUES ($1, 0.9, false, NULL, '{}', $2)
         ON CONFLICT (lane, lane_p, ruled, protocol, facts, sentence_id) DO UPDATE SET lane = excluded.lane RETURNING id`,
        [lane, s.rows[0]!.id],
      );
      labels.set(lane, l.rows[0]!.id);
    }
    return labels.get(lane)!;
  };

  const tick = async (): Promise<void> => {
    n += 1;
    const part = BigInt(n) / R.PARTITION_BLOCKS;
    for (const table of ['_blocks', 'usdc_transfer', '_insights']) {
      const key = `${table}:${part}`;
      if (!made.has(key)) {
        await admin.query(partitionDdl(R.SCHEMA, table, part, R.PARTITION_BLOCKS));
        made.add(key);
      }
    }
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO ${S}._blocks (block_number, block_hash, block_time) VALUES ($1, $2, now())`, [n, randomBytes(32)]);
      const moves = 1 + Math.floor(Math.random() * 3);
      for (let li = 0; li < moves; li++) {
        const from = pick(PARTIES);
        let to = pick(PARTIES);
        while (to === from) to = pick(PARTIES);
        const value = (BigInt(1 + Math.floor(Math.random() * 200_000)) * 10n ** 16n).toString();
        await c.query(
          `INSERT INTO ${S}.usdc_transfer (block_number, tx_hash, log_index, from_id, to_id, value) VALUES ($1, $2, $3, $4, $5, $6)`,
          [n, randomBytes(32), li, await idOf(c, from), await idOf(c, to), value],
        );
        const lane = pick(LANES);
        await c.query(`INSERT INTO ${S}._insights (block_number, log_index, lane, label_id) VALUES ($1, $2, $3, $4)`, [n, li, lane, await labelOf(c, lane)]);
      }
      await c.query(`UPDATE ${S}._cursor SET last_block = $1`, [n]);
      await c.query(`UPDATE ${S}._insights_cursor SET last_block = $1`, [n]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };

  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (err) {
      console.error('smoke feed:', err instanceof Error ? err.message : err);
    }
    if (!stopped) timer = setTimeout(loop, everyMs);
  };
  void loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
```

- [ ] **Step 2: Write the server and the Playwright config**

`packages/explorer/smoke/serve.ts`:

```ts
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
```

`packages/explorer/smoke/playwright.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results',
  use: { baseURL: 'http://127.0.0.1:3107' },
  webServer: {
    command: 'node --experimental-strip-types smoke/serve.ts',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:3107/api/health',
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

- [ ] **Step 3: Write the smoke tests**

`packages/explorer/smoke/smoke.spec.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { BUSY, SWAP_TX } from '../test/fixture/rows.ts';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

test('the tape fills and flows', async ({ page }) => {
  await page.goto('/');
  const first = page.locator('.tape .row').first();
  await expect(first).toBeVisible();
  const href = await first.getAttribute('href');
  await expect.poll(() => page.locator('.tape .row').first().getAttribute('href'), { timeout: 15_000 }).not.toBe(href);
  await expect(page.locator('h1')).toContainText('In the last minute');
});

test('hovering the tape pauses it and leaving drains it', async ({ page }) => {
  await page.goto('/');
  const tape = page.locator('.tape');
  await expect(tape.locator('.row').first()).toBeVisible();
  await tape.hover();
  const held = await tape.locator('.row').first().getAttribute('href');
  await page.waitForTimeout(3000);
  expect(await tape.locator('.row').first().getAttribute('href')).toBe(held);
  await expect(page.locator('.waiting')).toBeVisible();
  await page.mouse.move(5, 5);
  await expect.poll(() => tape.locator('.row').first().getAttribute('href'), { timeout: 10_000 }).not.toBe(held);
});

test('a row opens its transaction', async ({ page }) => {
  await page.goto('/');
  await page.locator('.tape .row').first().click();
  await expect(page).toHaveURL(/\/tx\/0x[0-9a-f]{64}$/);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.events .ev').first()).toBeVisible();
});

test('search routes both ways and hints otherwise', async ({ page }) => {
  await page.goto('/');
  const q = page.locator('input[name=q]');
  await q.fill(SWAP_TX.toUpperCase().replace('0X', '0x'));
  await q.press('Enter');
  await expect(page).toHaveURL(`/tx/${SWAP_TX}`);
  await expect(page.locator('h1')).toContainText('swapped');
  await expect(page.locator('.swapbox')).toContainText('476.93');
  await page.locator('input[name=q]').fill(BUSY);
  await page.locator('input[name=q]').press('Enter');
  await expect(page).toHaveURL(`/address/${BUSY}`);
  await expect(page.locator('.stats')).toBeVisible();
  await page.locator('input[name=q]').fill('hello');
  await page.locator('input[name=q]').press('Enter');
  await expect(page.locator('.search .hint')).toBeVisible();
});

for (const [w, h] of [[1440, 1000], [390, 844]] as const) {
  test(`pages render at ${w} px without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, path] of [['home', '/'], ['tx', `/tx/${SWAP_TX}`], ['address', `/address/${BUSY}`]] as const) {
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      if (name === 'home') await expect(page.locator('.tape .row').first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} scrolls sideways at ${w} px`).toBeLessThanOrEqual(0);
      if (name === 'home' && w < 520) await expect(page.locator('.tape .row .who').first()).toBeHidden();
      await page.screenshot({ path: `${SHOTS}${name}-${w}.png`, fullPage: true });
    }
  });
}
```

- [ ] **Step 4: Run it**

```bash
corepack pnpm --filter @arckive/core build
NEXT_TELEMETRY_DISABLED=1 corepack pnpm --filter @arckive/explorer build
corepack pnpm --filter @arckive/explorer exec playwright install chromium
corepack pnpm --filter @arckive/explorer smoke
```

Expected: 6 tests pass; six screenshots in `packages/explorer/smoke/screenshots/`. Look at each screenshot against the mockups (`docs/superpowers/specs/2026-10-08-arckive-explorer-mockups/*.png`) and fix layout differences in `globals.css` before committing.

- [ ] **Step 5: Lint and commit**

```bash
corepack pnpm lint
git add packages/explorer/smoke
git commit -m "test(explorer): local browser smoke — tape flow, hover pause, row click, search, desktop and phone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

---

### Task 16: Real test on k3d (controller-run)

Runs against the running k3d cluster `arckive` (operator a2, Indexer `arc-explorer`, StatefulSet `pg-explorer`). It deploys inside the cluster only: no tunnel, no DNS, no public hostname. Never print the DSN or the role password.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-arckive-explorer-design.md` (append a "Measured" section)
- Scratch (not committed): measurement scripts in the session scratchpad

- [ ] **Step 1: State of the archive**

```bash
kubectl --context k3d-arckive get indexer arc-explorer
kubectl --context k3d-arckive exec pg-explorer-0 -- psql -U arckive -d explorer -Atc \
  "select last_block from idx_arc_explorer._cursor; select count(*) from idx_arc_explorer.usdc_transfer; select pg_size_pretty(pg_database_size('explorer'))"
```

Record block, rows and size; the measurements below describe the history present at this moment.

- [ ] **Step 2: Role, Secret, image, Deployment**

```bash
kubectl --context k3d-arckive exec -i pg-explorer-0 -- psql -U arckive -d explorer -v ON_ERROR_STOP=1 < manifests/arc-mainnet/k8s/explorer-role.sql
PW=$(openssl rand -hex 24)
printf "ALTER ROLE explorer PASSWORD '%s';\n" "$PW" | kubectl --context k3d-arckive exec -i pg-explorer-0 -- psql -q -U arckive -d explorer -v ON_ERROR_STOP=1
kubectl --context k3d-arckive create secret generic explorer-dsn --from-literal=url="postgres://explorer:${PW}@pg-explorer:5432/explorer"
unset PW
docker build --target explorer -t arckive-explorer:dev . && k3d image import arckive-explorer:dev -c arckive
kubectl --context k3d-arckive apply -f manifests/arc-mainnet/k8s/explorer-app.yaml
kubectl --context k3d-arckive rollout status deploy/explorer --timeout=180s
kubectl --context k3d-arckive port-forward deploy/explorer 3100:3000 &
curl -s localhost:3100/api/health
```

Expected: `{"ok":true,…}` with `head`, `released` near `head.block`, `rolledTo` advancing.

- [ ] **Step 3: Measure the spec's targets**

With scripts in the scratchpad, through the port-forward:
- `/tx/[hash]`: 200 requests over 50 hashes sampled from `usdc_transfer` and `poolmanager_swap` across the history; p95 of `curl -w %{time_starttransfer}` (target < 150 ms).
- `/address/[address]`: the 20 busiest addresses by `in_count + out_count` in `explorer.address_daily`, first page and one `?before=` page each, 5 rounds; p95 (target < 300 ms).
- Tailer: `tailerMs.p95` from `/api/health` after 5 minutes (target < 50 ms).
- 500 concurrent streams (a Node script opening 500 `fetch` readers on `/api/stream` for 3 minutes): `kubectl top pod` for the explorer pod during it (target < 1 core, < 300 MB); every reader received `stats` every second.
- Tape latency: one stream for 5 minutes; per `block` message, receipt time − block time; p95 (target ≤ `LANE_HOLD_MS` + 1 s; with lanes not switched on the hold does not apply).
- Rollup: time from `rolledTo` = null to caught up, and its rows.

- [ ] **Step 4: Look at it**

Screenshots of `/`, a busy `/tx/…` (a swap), and the busiest `/address/…` at 1440 and 390 px through the port-forward; compare with the mockups; fix what differs (each fix its own commit, re-run the smoke).

- [ ] **Step 5: Record and commit**

Append to the spec:

```markdown
## Measured (k3d, <date>)

Archive at block <n> (<rows> transfers, <size>); lanes not switched on yet.

| Target | Goal | Measured |
|---|---|---|
| `/tx/[hash]` server time, p95 | < 150 ms | … |
| `/address/[address]`, 20 busiest, p95 | < 300 ms | … |
| Tailer cycle, p95 | < 50 ms | … |
| 500 streams | < 1 core, < 300 MB | … |
| Tape latency, p95 | ≤ hold + 1 s | … |
```

```bash
git add docs/superpowers/specs/2026-10-08-arckive-explorer-design.md
git commit -m "docs: explorer measured on k3d

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ln6dBHEv9z2MvwWYtPqcfg"
```

Publishing (tunnel or Dokploy, hostname, DNS) and switching lanes on (`insights` with the user's Laya header Secret) are the user's next step, not this plan's.
