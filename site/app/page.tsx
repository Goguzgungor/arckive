import CopyCmd from "@/components/CopyCmd";
import Mark from "@/components/Mark";
import { DistantRange, FooterScene, Grain, HeroScene, RadarScene, SceneDefs } from "@/components/Scenery";
import StarButton from "@/components/StarButton";

const REPO = "https://github.com/Goguzgungor/arckive";
const RADAR = "https://radar.arckive.org";
const EXPLORER = "https://explorer.arckive.org";

const LANES = ["swap", "bridge", "liquidity", "vault", "lending", "signed_payment", "payment", "no_transfer"];

// Sample rows in the shape `_insights` writes; lanes and confidences are of
// the kind measured on Arc mainnet, not a live feed.
const SAMPLE = [
  { event: "pool_manager.Swap", lane: "swap", p: "0.97", protocol: "Uniswap", hot: true },
  { event: "usdc.Transfer", lane: "bridge", p: "0.97", protocol: "Relay" },
  { event: "positions.IncreaseLiquidity", lane: "liquidity", p: "0.98", protocol: "Aerodrome" },
  { event: "usdc.Transfer", lane: "signed_payment", p: "0.99", protocol: "usdc" },
  { event: "permit2.Approval", lane: "no_transfer", p: "rule", protocol: "permit2" },
];

const COMPARE: [string, string, string, string, string][] = [
  ["Data in your own database", "No", "Via graph-node", "If you build it", "Yes"],
  ["Plain SQL access", "Dune SQL only", "GraphQL", "Raw JSON", "Yes"],
  ["Reorgs and gaps", "Theirs", "Yes", "On you", "No reorgs on Arc · gap-free cursor"],
  ["What each event was part of", "Write the SQL", "Write the mapping", "On you", "Built in · Insights"],
  ["Setup", "Low", "Medium–high", "High", "One YAML"],
];

export default function Page() {
  return (
    <main>
      <SceneDefs />

      {/* ———— hero ———— */}
      <header className="hero" id="top">
        <HeroScene />
        <Grain />
        <div className="topbar">
          <a className="brand" href="#top">
            <Mark />
            <span>Arckive</span>
          </a>
          <nav className="nav">
            <a href="#how">How it works</a>
            <a href="#insights">Insights</a>
            <a href="#benchmarks">Benchmarks</a>
            <a href={EXPLORER}>Explorer</a>
            <a href={RADAR}>Arc Radar</a>
            <a href={REPO}>GitHub</a>
          </nav>
        </div>
        <div className="hero-body">
          <div className="hero-copy">
            <p className="label">Event indexer for Arc · v1alpha1 · Apache-2.0</p>
            <h1>
              Your chain events,
              <br />
              <em>in your own Postgres.</em>
            </h1>
            <p className="hero-sub">
              A Kubernetes-native indexer for Arc. Declare one manifest; an operator keeps a worker streaming every
              event into the database you already run.
            </p>
            <div className="ctas">
              <a className="btn" href="#start">
                Get started
              </a>
              <a className="btn-line" href="#how">
                See the manifest
              </a>
            </div>
          </div>
          <div className="stat-cards">
            <div className="card stat-card">
              <p>One typed table per event, committed together with its checkpoint.</p>
              <p className="stat">
                <span className="num">395 ms</span>
                <span className="label">block → SQL, p50</span>
              </p>
            </div>
            <div className="card stat-card">
              <p>New: every event says what it was part of — a swap, a bridge, a payment.</p>
              <p className="stat">
                <span className="num">0.22 s</span>
                <span className="label">lanes behind ingest</span>
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* ———— 01 how it works ———— */}
      <section id="how" className="sec wrap">
        <div className="sec-head ruled">
          <div>
            <p className="label">01 — How it works</p>
            <h2>
              Declare it. <em>The operator does the rest.</em>
            </h2>
          </div>
          <p className="lede">
            One <code>Indexer</code> resource describes what you want. An operator turns it into a running worker and
            keeps it that way.
          </p>
        </div>
        <div className="steps">
          <article className="paper step">
            <p className="label accent">Step 01</p>
            <h3>Write one manifest</h3>
            <p>Network, Postgres, contracts. That is the whole setup.</p>
            <pre>
              <span className="k">kind</span>: Indexer{"\n"}
              <span className="k">metadata</span>: {"{ "}
              <span className="k">name</span>: usdc-arc{" }\n"}
              <span className="k">spec</span>:{"\n"}
              {"  "}
              <span className="k">network</span>: {"{ "}
              <span className="k">chainId</span>: 5042002{" }\n"}
              {"  "}
              <span className="k">contracts</span>:{"\n"}
              {"    - "}
              <span className="k">name</span>: usdc{"\n"}
              {"      "}
              <span className="k">address</span>: <span className="s">&quot;0x3600…0000&quot;</span>
              {"\n"}
              {"      "}
              <span className="k">events</span>: [Transfer]
            </pre>
          </article>
          <article className="paper step">
            <p className="label accent">Step 02</p>
            <h3>The operator provisions</h3>
            <p>A reconcile loop turns the spec into running parts, and heals them.</p>
            <div className="flow">
              <div className="node">Indexer CR — one YAML</div>
              <div className="link">↓ reconciles</div>
              <div className="node hot">Arckive operator</div>
              <div className="link">↓ provisions</div>
              <div className="node">worker · schema · status</div>
            </div>
          </article>
          <article className="paper step">
            <p className="label accent">Step 03</p>
            <h3>Query plain SQL</h3>
            <p>Each event is a table in your Postgres. No API between you and your rows.</p>
            <pre>
              <span className="c">-- one table per event</span>
              {"\n"}
              <span className="k">SELECT</span> &quot;from&quot;, &quot;to&quot;, value{"\n"}
              <span className="k">FROM</span> idx_usdc_arc.usdc_transfer{"\n"}
              <span className="k">WHERE</span> value &gt; 1000000000{"\n"}
              <span className="k">ORDER BY</span> block_number <span className="k">DESC</span>;
            </pre>
          </article>
        </div>
      </section>

      {/* ———— 02 insights ———— */}
      <section id="insights" className="band-insights">
        <DistantRange />
        <Grain opacity={0.18} />
        <div className="wrap insights">
          <div className="insights-copy">
            <p className="label accent">02 — Insights · new</p>
            <h2>
              Every event knows <em>what it was part of.</em>
            </h2>
            <p className="lede">
              Turn on <code>insights</code> and each row gets a lane — the kind of transaction it belonged to — and the
              protocol that handled it. The same engine as Arc Radar, for any contract you index. A URL and a header is
              the whole configuration.
            </p>
            <div className="chips">
              {LANES.map((l, i) => (
                <span key={l} className={i === 0 ? "chip hot" : "chip"}>
                  {l}
                </span>
              ))}
            </div>
            <p className="mono small">Ingest never waits for it · lanes run in their own loop</p>
          </div>
          <div className="insights-table">
            <div className="card table-card">
              <div className="table-head">
                <span>idx_arc._insights</span>
                <span className="faint">sample output</span>
              </div>
              <div className="scroll-x">
                <table className="mono">
                  <thead>
                    <tr>
                      <th>event</th>
                      <th>lane</th>
                      <th className="num">lane_p</th>
                      <th>protocol</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SAMPLE.map((r) => (
                      <tr key={`${r.event}-${r.lane}`}>
                        <td>{r.event}</td>
                        <td>
                          <span className={r.hot ? "chip hot" : "chip"}>{r.lane}</span>
                        </td>
                        <td className={r.p === "rule" ? "num faint" : "num"}>{r.p}</td>
                        <td className="soft">{r.protocol}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <pre className="table-sql">
                <span className="k">SELECT</span> t.value, i.lane, i.protocol{"\n"}
                <span className="k">FROM</span> usdc_transfer t <span className="k">JOIN</span> _insights i{" "}
                <span className="k">USING</span> (block_number, tx_hash, log_index){"\n"}
                <span className="k">WHERE</span> i.lane = <span className="s">&apos;bridge&apos;</span>;
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* ———— 03 reliability ———— */}
      <section id="reliability" className="sec wrap">
        <p className="label">03 — Reliability</p>
        <h2 className="h2-gap">
          Even if the network blips, <em>no event is lost.</em>
        </h2>
        <div className="ruled-grid">
          <div className="cell">
            <span className="mono accent">/01</span>
            <h3>Cursor and checkpoint</h3>
            <p>The last processed block lives in Postgres. After any crash it resumes exactly there.</p>
          </div>
          <div className="cell">
            <span className="mono accent">/02</span>
            <h3>One transaction</h3>
            <p>Event rows and the cursor advance commit together — everything, or nothing.</p>
          </div>
          <div className="cell">
            <span className="mono accent">/03</span>
            <h3>Built on Arc&apos;s finality</h3>
            <p>
              Indexes to the <code>finalized</code> tag. Finalized blocks never roll back, so there is no rollback code
              at all.
            </p>
          </div>
          <div className="cell">
            <span className="mono accent">/04</span>
            <h3>RPC failover</h3>
            <p>Endpoints are health-checked and kept in a fixed order. A blip never becomes a gap.</p>
          </div>
        </div>
      </section>

      {/* ———— 04 benchmarks ———— */}
      <section id="benchmarks" className="sec wrap">
        <div className="sec-head">
          <div>
            <p className="label">04 — Benchmarks</p>
            <h2>
              Measured, <em>not promised.</em>
            </h2>
          </div>
          <p className="lede">
            Every number is read from the product&apos;s own output — Postgres rows and <code>/metrics</code>.
            Reproduce it with <code>pnpm bench</code>.{" "}
            <a className="underline" href="/benchmarks.html">
              Full report
            </a>
          </p>
        </div>
        <div className="ruled-grid bench">
          <div className="cell">
            <span className="label">block → SQL, p50</span>
            <p className="big">
              395<span> ms</span>
            </p>
            <p>Arc testnet, live USDC traffic. p99 under one second.</p>
          </div>
          <div className="cell">
            <span className="label">backfill</span>
            <p className="big">
              92.6<span> blocks/s</span>
            </p>
            <p>5,107 blocks of history in 55 s — about 48× faster than the chain.</p>
          </div>
          <div className="cell">
            <span className="label">burst ingest</span>
            <p className="big">
              2,628<span> ev/s</span>
            </p>
            <p>The decode and single-transaction write ceiling.</p>
          </div>
          <div className="cell">
            <span className="label accent">insights · new</span>
            <p className="big">
              0.22<span> s</span>
            </p>
            <p>Median lane delay behind ingest — Arc mainnet, four contracts.</p>
          </div>
        </div>
      </section>

      {/* ———— arc radar ———— */}
      <section id="radar" className="sec wrap">
        <div className="radar">
          <RadarScene />
          <Grain opacity={0.22} />
          <div className="radar-body">
            <div>
              <p className="label">Live on Arc mainnet</p>
              <h2>
                Arc Radar — <em>every USDC transfer, sorted as it lands.</em>
              </h2>
              <p className="lede">Swap, bridge, liquidity, payment. Ask the stream a yes/no question and watch it re-sort.</p>
              <p className="lede">
                Every transfer opens in Arckive Explorer, built on Arckive’s own index of Arc mainnet: look up any
                transaction or address.
              </p>
            </div>
            <div className="radar-actions">
              <a className="btn" href={RADAR}>
                Open Arc Radar →
              </a>
              <a className="btn-line" href={EXPLORER}>
                Open the Explorer →
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ———— 05 compare ———— */}
      <section id="compare" className="sec wrap">
        <p className="label">05 — Compare</p>
        <h2 className="h2-gap">
          A combination <em>nobody else offers.</em>
        </h2>
        <div className="scroll-x">
          <table className="compare">
            <thead>
              <tr className="label">
                <th />
                <th>Dune</th>
                <th>The Graph</th>
                <th>Raw RPC</th>
                <th className="accent">Arckive</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([what, dune, graph, raw, us]) => (
                <tr key={what}>
                  <td>{what}</td>
                  <td className="they">{dune}</td>
                  <td className="they">{graph}</td>
                  <td className="they">{raw}</td>
                  <td>{us}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ———— get started ———— */}
      <section id="start" className="start wrap">
        <p className="label">Get started</p>
        <h2>
          One YAML. <em>A running indexer.</em>
        </h2>
        <CopyCmd cmd="kubectl apply -f https://arckive.org/install.yaml" />
        <p className="star-ask">
          Arckive is open source. If it saves you a subgraph, a star helps other Arc builders find it.
        </p>
        <StarButton href={REPO} className="btn-line" />
        <p className="label">Runs in your cluster · your data never leaves it</p>
      </section>

      {/* ———— footer ———— */}
      <footer className="footer">
        <FooterScene />
        <Grain opacity={0.22} />
        <div className="footer-grid">
          <div className="footer-brand">
            <a className="brand" href="#top">
              <Mark />
              <span>Arckive</span>
            </a>
            <p className="footer-tag">
              Your chain events, in your own Postgres.
              <br />
              Built for Arc · runs in your cluster.
            </p>
            <p className="footer-copy">© 2026 Arckive · Apache-2.0</p>
          </div>
          <div className="footer-cols">
            <div>
              <h2>Product</h2>
              <a href="#how">How it works</a>
              <a href="#insights">Insights</a>
              <a href="#benchmarks">Benchmarks</a>
              <a href={EXPLORER}>Explorer</a>
              <a href={RADAR}>Arc Radar</a>
            </div>
            <div>
              <h2>Docs</h2>
              <a href={`${REPO}#readme`}>Quickstart</a>
              <a href="/install.yaml">install.yaml</a>
              <a href="/demo.yaml">demo.yaml</a>
              <a href="/benchmarks.html">Report</a>
            </div>
            <div>
              <h2>Project</h2>
              <a href={REPO}>GitHub</a>
              <a href={`${REPO}/issues`}>Issues</a>
              <a href={`${REPO}/releases`}>Releases</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
