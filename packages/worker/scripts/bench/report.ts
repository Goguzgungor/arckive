// results.json → self-contained single-file HTML report (no CDN,
// inline CSS + SVG; light/dark theme). Report language is English — the arckive.org audience.
//   node --experimental-strip-types scripts/bench/report.ts [path to results.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BackfillResult } from './backfill.ts';
import type { BurstResult } from './burst.ts';
import type { FreshnessResult } from './freshness.ts';
import type { VisibilityResult } from './visibility.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');

interface Results {
  meta: { date: string; gitSha: string; node: string };
  visibility?: VisibilityResult | { error: string };
  freshness?: FreshnessResult | { error: string };
  backfill?: BackfillResult | { error: string };
  burst?: BurstResult | { error: string };
}

function ok<T extends { kind: string }>(r: T | { error: string } | undefined): T | null {
  return r && !('error' in r) ? r : null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtS = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const fmtN = (n: number) => n.toLocaleString('en-US');
const sec = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

// ---- axis helpers -------------------------------------------------------

function niceTicks(max: number, count = 4): number[] {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => max / s <= count) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// ---- charts -------------------------------------------------------------

// freshness: per-sample latency dots + p50 reference line
function freshnessChart(f: FreshnessResult): string {
  const W = 720;
  const H = 260;
  const M = { t: 16, r: 16, b: 34, l: 52 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const ys = f.samplesMs;
  const yMax = Math.max(...ys) * 1.15;
  const x = (i: number) => M.l + (ys.length === 1 ? iw / 2 : (i / (ys.length - 1)) * iw);
  const y = (v: number) => M.t + ih - (v / yMax) * ih;

  const grid = niceTicks(yMax)
    .map(
      (t) =>
        `<line x1="${M.l}" y1="${y(t)}" x2="${W - M.r}" y2="${y(t)}" class="grid"/>` +
        `<text x="${M.l - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${(t / 1000).toFixed(1)}s</text>`,
    )
    .join('');
  const dots = ys
    .map(
      (v, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" class="dot">` +
        `<title>event ${i + 1} — ${sec(v)}</title></circle>`,
    )
    .join('');
  const p50y = y(f.stats.p50);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Per-event block-to-SQL latency">
    ${grid}
    <line x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}" class="axis"/>
    <line x1="${M.l}" y1="${p50y}" x2="${W - M.r}" y2="${p50y}" class="ref"/>
    ${dots}
    <text x="${W - M.r - 4}" y="${p50y - 8}" class="ref-label" text-anchor="end">p50 ${sec(f.stats.p50)}</text>
    <text x="${M.l + iw / 2}" y="${H - 8}" class="tick" text-anchor="middle">events in block order · blocks ${fmtN(f.blockSpan.from)} → ${fmtN(f.blockSpan.to)}</text>
  </svg>`;
}

// backfill: blocks remaining → 0 (catch-up curve)
function backfillChart(b: BackfillResult): string {
  const W = 720;
  const H = 260;
  const M = { t: 16, r: 16, b: 34, l: 64 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const target = b.startBlock + b.blocksProcessed - 1;
  const pts = b.series.map((s) => ({ t: s.tMs / 1000, behind: Math.max(0, target - s.block) }));
  if (pts.length > 0 && pts[pts.length - 1]!.behind !== 0) pts.push({ t: b.durationMs / 1000, behind: 0 });
  const tMax = Math.max(...pts.map((p) => p.t));
  const bMax = Math.max(...pts.map((p) => p.behind)) * 1.05;
  const x = (t: number) => M.l + (t / tMax) * iw;
  const y = (v: number) => M.t + ih - (v / bMax) * ih;

  const yTicks = niceTicks(bMax)
    .map(
      (t) =>
        `<line x1="${M.l}" y1="${y(t)}" x2="${W - M.r}" y2="${y(t)}" class="grid"/>` +
        `<text x="${M.l - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${fmtN(Math.round(t))}</text>`,
    )
    .join('');
  const xTicks = niceTicks(tMax)
    .map((t) => `<text x="${x(t)}" y="${H - 8}" class="tick" text-anchor="middle">${Math.round(t)}s</text>`)
    .join('');
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.behind).toFixed(1)}`).join('');
  const area = `${path}L${x(tMax).toFixed(1)},${y(0)}L${x(pts[0]!.t).toFixed(1)},${y(0)}Z`;
  const hover = pts
    .map(
      (p) =>
        `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.behind).toFixed(1)}" r="7" class="hit">` +
        `<title>t=${Math.round(p.t)}s — ${fmtN(p.behind)} blocks behind</title></circle>`,
    )
    .join('');
  const end = pts[pts.length - 1]!;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Backfill catch-up curve: blocks behind over time">
    ${yTicks}
    <line x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}" class="axis"/>
    <path d="${area}" class="area"/>
    <path d="${path}" class="line"/>
    <circle cx="${x(end.t).toFixed(1)}" cy="${y(end.behind).toFixed(1)}" r="5" class="dot"/>
    <text x="${x(end.t) - 10}" y="${y(end.behind) - 10}" class="ref-label" text-anchor="end">Live</text>
    ${hover}
    ${xTicks}
  </svg>`;
}

// ---- sections -----------------------------------------------------------

function tile(label: string, value: string, sub?: string): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div>
    <div class="tile-value">${esc(value)}</div>${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ''}</div>`;
}

function errP(name: string, r: { error: string } | undefined): string {
  return r ? `<p class="err">${name} scenario failed: ${esc(r.error)}</p>` : '';
}

function freshnessSection(
  f: FreshnessResult | { error: string } | undefined,
  visibility?: VisibilityResult | { error: string },
): string {
  const r = ok(f);
  if (!r) return errP('freshness', f as { error: string } | undefined);
  const vis = ok(visibility as VisibilityResult | { error: string });
  const budget = vis
    ? `<p>Latency budget: the RPC's own <code>newHeads</code> subscription first announces a block
  <strong>${sec(vis.stats.p50)}</strong> (p50) after its validator timestamp — that provider floor is
  outside any indexer's control. Arckive adds only
  <strong>~${Math.max(0, Math.round((r.stats.p50 - vis.stats.p50) / 10) * 10)}ms</strong> on top:
  the head signal triggers an immediate round — one <code>eth_getLogs</code> plus the transactional
  SQL write. No polling interval in the hot path.</p>`
    : '';
  const rows = r.samplesMs
    .map((v, i) => `<tr><td>${i + 1}</td><td>${sec(v)}</td></tr>`)
    .join('');
  return `
  <div class="eyebrow">Scenario 1 · Arc public testnet</div>
  <h2>Freshness — block close to SQL row</h2>
  <p>A worker subscribed to <code>newHeads</code> over WebSocket (<em>listening, not polling</em> —
  ${fmtN(r.headNotifications)} head signals in the window) and tailed native USDC
  (<code>${esc(r.contractAddress.slice(0, 8))}…</code>) <code>Transfer</code> events on the real Arc
  testnet. Latency is read from the product's own meta columns of <code>_blocks</code> —
  <code>_ingested_at − block_time</code> — once per block that carried an event in the window:
  <strong>${r.stats.count} blocks</strong> of genuine third-party traffic.</p>
  <div class="tiles">
    ${tile('p50', sec(r.stats.p50), 'block close → queryable row')}
    ${tile('p90', sec(r.stats.p90))}
    ${tile('p99', sec(r.stats.p99))}
    ${tile('fastest', sec(r.stats.min))}
  </div>
  ${budget}
  <figure>${freshnessChart(r)}</figure>
  <details><summary>table view (${r.stats.count} samples)</summary>
    <table><thead><tr><th>#</th><th>latency</th></tr></thead><tbody>${rows}</tbody></table>
  </details>`;
}

function backfillSection(b: BackfillResult | { error: string } | undefined): string {
  const r = ok(b);
  if (!r) return errP('backfill', b as { error: string } | undefined);
  const chainHours = r.chainSpanSec / 3600;
  const speedup = r.durationMs > 0 ? (r.chainSpanSec * 1000) / r.durationMs : 0;
  return `
  <div class="eyebrow">Scenario 2 · Arc public testnet</div>
  <h2>Backfill — catching up on real USDC history</h2>
  <p>The worker started <strong>${fmtN(r.blocksProcessed)} blocks</strong> behind
  (≈ ${chainHours.toFixed(1)} hours of chain time) on Arc testnet's native USDC contract and reached
  <strong>Live</strong> in <strong>${fmtS(r.durationMs)}</strong> —
  <strong>${fmtN(Math.round(r.blocksPerSec))} blocks/s</strong> over a public RPC, decoding and
  writing ${fmtN(r.events)} transfer events along the way (<code>batchBlocks: 1000</code>).</p>
  <div class="tiles">
    ${tile('catch-up rate', `${fmtN(Math.round(r.blocksPerSec))} blocks/s`, `~${fmtN(Math.round(speedup))}× faster than the chain`)}
    ${tile('time to Live', fmtS(r.durationMs), `${fmtN(r.blocksProcessed)} blocks`)}
    ${tile('events', fmtN(r.events), 'USDC transfers')}
  </div>
  <figure>${backfillChart(r)}</figure>`;
}

function burstSection(b: BurstResult | { error: string } | undefined): string {
  const r = ok(b);
  if (!r) return errP('burst', b as { error: string } | undefined);
  return `
  <div class="eyebrow">Scenario 3 · local network</div>
  <h2>Burst — the write-path ceiling</h2>
  <p>${fmtN(r.seededEvents)} <code>Ping</code> events were packed into ${r.seededBlocks} dense blocks
  on a local anvil chain, then a worker cold-started and ingested all of them in
  <strong>${fmtS(r.ingestDurationMs)}</strong> — <strong>${fmtN(r.eventsPerSec)} events/s</strong>
  through the full decode + single-transaction SQL write path, with WAN latency out of the picture.</p>
  <div class="tiles">
    ${tile('ingest rate', `${fmtN(r.eventsPerSec)} events/s`, 'decode + transactional SQL write')}
    ${tile('events', fmtN(r.ingestedEvents), `in ${fmtS(r.ingestDurationMs)}`)}
    ${r.avgWriteLatencyMs !== null ? tile('avg DB write', `${r.avgWriteLatencyMs}ms`, 'per batch') : ''}
  </div>`;
}

// ---- page ---------------------------------------------------------------

export function render(results: Results): string {
  const f = ok(results.freshness);
  const bf = ok(results.backfill);
  const bu = ok(results.burst);
  const kpis = [
    f ? tile('block → SQL, p50 (testnet)', sec(f.stats.p50), 'ws listening mode') : '',
    bf ? tile('backfill catch-up', `${fmtN(Math.round(bf.blocksPerSec))} blocks/s`, 'real USDC history') : '',
    bu ? tile('burst ingest', `${fmtN(bu.eventsPerSec)} events/s`, 'local write-path ceiling') : '',
  ].join('');

  return `<meta charset="utf-8">
<title>arckive benchmarks</title>
<style>
  :root { --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --axis:#c3c2b7; --s1:#2a78d6; --border:rgba(11,11,11,.10);
    color-scheme:light dark; }
  @media (prefers-color-scheme: dark) { :root { --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff;
    --ink-2:#c3c2b7; --grid:#2c2c2a; --axis:#383835; --s1:#3987e5;
    --border:rgba(255,255,255,.10); } }
  :root[data-theme="dark"] { --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7;
    --grid:#2c2c2a; --axis:#383835; --s1:#3987e5; --border:rgba(255,255,255,.10); }
  :root[data-theme="light"] { --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e;
    --grid:#e1e0d9; --axis:#c3c2b7; --s1:#2a78d6; --border:rgba(11,11,11,.10); }
  .bench { max-width:860px; margin:0 auto; padding:40px 20px 64px;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); }
  body { background:var(--page); margin:0; }
  .bench h1 { font-size:30px; margin:0 0 6px; letter-spacing:-.01em; }
  .bench h1 .accent { color:var(--s1); }
  .bench .sub { color:var(--ink-2); margin:0 0 30px; font-size:14.5px; max-width:64ch; line-height:1.5; }
  .eyebrow { font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted);
    margin:44px 0 4px; }
  .bench h2 { font-size:20px; margin:0 0 8px; text-wrap:balance; }
  .bench p { line-height:1.55; color:var(--ink-2); font-size:15px; max-width:70ch; }
  .bench p strong { color:var(--ink); }
  .bench code { background:var(--surface); border:1px solid var(--border); border-radius:4px;
    padding:1px 5px; font-size:13px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .tiles { display:flex; flex-wrap:wrap; gap:12px; margin:18px 0; }
  .tile { background:var(--surface); border:1px solid var(--border); border-radius:10px;
    padding:14px 18px; min-width:150px; flex:1; }
  .tile-label { font-size:12.5px; color:var(--muted); margin-bottom:6px; }
  .tile-value { font-size:26px; font-weight:600; }
  .kpi .tile-value { font-size:34px; }
  .tile-sub { font-size:12.5px; color:var(--ink-2); margin-top:4px; }
  figure { margin:12px 0; background:var(--surface); border:1px solid var(--border);
    border-radius:10px; padding:12px; overflow-x:auto; }
  svg { display:block; width:100%; height:auto; min-width:560px; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .axis { stroke:var(--axis); stroke-width:1; }
  .tick, .ref-label { fill:var(--muted); font-size:11.5px; font-family:inherit;
    font-variant-numeric:tabular-nums; }
  .ref-label { fill:var(--ink-2); stroke:var(--surface); stroke-width:3; paint-order:stroke; }
  .dot { fill:var(--s1); stroke:var(--surface); stroke-width:2; }
  .hit { fill:transparent; }
  .line { fill:none; stroke:var(--s1); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .area { fill:var(--s1); opacity:.1; }
  .ref { stroke:var(--muted); stroke-width:1; opacity:.6; }
  details { margin:10px 0 0; font-size:13.5px; color:var(--ink-2); }
  details table { border-collapse:collapse; margin-top:8px; }
  details td, details th { border:1px solid var(--grid); padding:3px 10px;
    font-variant-numeric:tabular-nums; }
  .err { color:#d03b3b; }
  .meta { margin-top:48px; padding-top:16px; border-top:1px solid var(--grid);
    font-size:13px; color:var(--muted); line-height:1.65; max-width:78ch; }
  .meta strong { color:var(--ink-2); }
</style>
<div class="bench">
  <h1><span class="accent">arckive</span> benchmarks</h1>
  <p class="sub">A Kubernetes-native contract-event indexer for Arc: apply an <code>Indexer</code> CR,
  get contract events as plain SQL rows in your own Postgres. Every number below was measured by
  running the real worker process and reading only its production surface — no benchmark
  instrumentation in product code. ${esc(results.meta.date.slice(0, 10))} ·
  <code>${esc(results.meta.gitSha)}</code></p>
  <div class="tiles kpi">${kpis}</div>
  ${freshnessSection(results.freshness, results.visibility)}
  ${backfillSection(results.backfill)}
  ${burstSection(results.burst)}
  <div class="meta">
    <strong>Methodology.</strong> Each scenario spawns the actual <code>arckive-worker</code> binary and
    observes it only through Postgres rows and its Prometheus <code>/metrics</code> endpoint — the same
    surface you would monitor in production. Freshness = <code>_ingested_at − block_time</code>
    per block (from <code>_blocks</code>; every row of a block shares both times), where <code>block_time</code> is the validator timestamp and <code>_ingested_at</code>
    is the database clock at insert (local clock assumed NTP-synced). The freshness worker runs in
    WS-hybrid mode: an <code>eth_subscribe(newHeads)</code> subscription triggers an immediate fetch
    round the moment a block is announced, and interval polling remains only as a safety net — the
    run is invalidated unless the WS connection stayed up for the whole window
    (<code>arckive_ws_connected</code>). Arc testnet RPC: drpc.org public endpoint. Reproduce with
    <code>pnpm bench</code> · Node ${esc(results.meta.node)}.
  </div>
</div>`;
}

function main(): void {
  const day = new Date().toISOString().slice(0, 10);
  const path = process.argv[2] ?? join(ROOT, 'docs', 'benchmarks', day, 'results.json');
  const results = JSON.parse(readFileSync(path, 'utf8')) as Results;
  const out = join(dirname(path), 'report.html');
  writeFileSync(out, render(results));
  console.log(`report: ${out}`);
}

main();
