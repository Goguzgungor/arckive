import Mark from "@/components/Mark";
import ThemeToggle from "@/components/ThemeToggle";
import ChaosLab from "@/components/ChaosLab";
import CopyCmd from "@/components/CopyCmd";
import IndexerStatus from "@/components/IndexerStatus";
import LatestEvents from "@/components/LatestEvents";
import { LiveIndexerProvider } from "@/components/LiveIndexer";
import StarButton, { StarIcon } from "@/components/StarButton";

const REPO = "https://github.com/Goguzgungor/arckive";
const RADAR = "https://radar.arckive.org";

function SecHead({ n, label }: { n: string; label: string }) {
  return (
    <div className="sec-head">
      <span className="sec-no">{n}</span>
      <span className="sec-label">{label}</span>
    </div>
  );
}

function Cover({
  tint,
  title,
  sub,
  name,
  desc,
}: {
  tint: string;
  title: React.ReactNode;
  sub: string;
  name: string;
  desc: React.ReactNode;
}) {
  return (
    <div className="book">
      <div className={`cover ${tint}`}>
        <span className="t">{title}</span>
        <span className="s">{sub}</span>
      </div>
      <b>{name}</b>
      <span>{desc}</span>
    </div>
  );
}

export default function Page() {
  return (
    <LiveIndexerProvider>
      <main>
        {/* ———— utility row ———— */}
        <div className="util">
          <div className="wrap util-inner">
            <span className="util-tagline">Kubernetes-native event indexer for Arc</span>
            <div className="util-links">
              <a className="hide-m" href={`${REPO}#readme`}>
                Documentation
              </a>
              <a className="hide-m" href={REPO}>
                GitHub
              </a>
              <a className="hide-m" href="#cta">
                Install
              </a>
              <ThemeToggle />
              <span className="version">v1alpha1</span>
            </div>
          </div>
        </div>

        {/* ———— nav ———— */}
        <nav className="nav" id="top">
          <div className="wrap nav-inner">
            <a className="brand" href="#top">
              <Mark size={26} />
              Arckive
            </a>
            <div className="nav-links">
              <a className="hide-m" href="#how">
                How it works
              </a>
              <a className="hide-m" href="#reliability">
                Reliability
              </a>
              <a className="hide-m" href="#benchmarks">
                Benchmarks
              </a>
              <a className="hide-m" href="#compare">
                Compare
              </a>
              <a className="hide-m" href={RADAR}>
                Arc Radar
              </a>
              <StarButton href={REPO} label="Star" />
              <a className="btn btn-sm" href="#cta">
                Get started
              </a>
            </div>
          </div>
        </nav>

        {/* ———— catalogue search row ———— */}
        <div className="search-band">
          <div className="wrap search">
            <div className="search-q" aria-label="Example query">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <span className="mono">
                SELECT &quot;from&quot;, &quot;to&quot;, value FROM usdc_transfer WHERE
                value &gt; 1000000000 ORDER BY block_number DESC;
              </span>
            </div>
            <a className="search-go" href="#how">
              Search
            </a>
            <span className="search-hint">
              Plain SQL · your Postgres · no API in between
            </span>
          </div>
        </div>

        {/* ———— hero ———— */}
        <header className="hero">
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <a className="star-pill" href={REPO} target="_blank" rel="noopener noreferrer">
                <StarIcon size={14} />
                <span className="hide-m">Open source —</span> Star Arckive on GitHub
                <span aria-hidden="true">→</span>
              </a>
              <h1>Your chain events, in your own Postgres.</h1>
              <p className="hero-sub">
                Give it an ABI, a contract address, and an RPC. Arckive streams
                every on-chain event into your own PostgreSQL —{" "}
                <strong>one table per event, reliable and gap-free</strong> —
                from a single YAML manifest.
              </p>
              <div className="hero-ctas">
                <a className="btn" href="#how">
                  See the one manifest
                </a>
                <a className="btn-line" href="#reliability">
                  Try to break it
                </a>
              </div>
              <p className="meta-line">
                Runs in your cluster · Apache-2.0 · arckive.org/v1alpha1
              </p>
            </div>
            <IndexerStatus />
          </div>
        </header>

        {/* ———— the gap ———— */}
        <div className="gap">
          <div className="wrap gap-inner">
            <span className="gap-label">The gap</span>
            <p>
              Dune is delayed and rate-limited. Raw logs leave reorgs and
              back-fill to you. The Graph means subgraphs and heavy ops. There
              was no declarative path to your events, in your Postgres, in plain
              SQL.
            </p>
          </div>
        </div>

        {/* ———— 01 how it works ———— */}
        <section id="how" className="section">
          <div className="wrap">
            <SecHead n="01" label="How it works" />
            <h2>Declare it. The operator does the rest.</h2>
            <p className="lede">
              One <code>Indexer</code> resource describes what you want. A
              Kubernetes operator keeps it true — database, schema, listener,
              optional read API.
            </p>

            <div className="steps">
              <div className="step">
                <span className="step-no">Step 1</span>
                <h3>Write one manifest</h3>
                <p>
                  Contracts, ABI ref, RPC pool, storage mode — the whole setup.
                </p>
                <div className="code">
                  <pre>
                    <span className="k">kind</span>: Indexer{"\n"}
                    <span className="k">metadata</span>: {"{ "}
                    <span className="k">name</span>: usdc-arc{" }\n"}
                    <span className="k">spec</span>:{"\n"}
                    {"  "}
                    <span className="k">rpc</span>:{" "}
                    <span className="c"># health-checked failover</span>
                    {"\n"}
                    {"    - "}
                    <span className="s">https://rpc.arc.example</span>
                    {"\n"}
                    {"  "}
                    <span className="k">storage</span>: {"{ "}
                    <span className="k">mode</span>: Embedded{" }\n"}
                    {"  "}
                    <span className="k">contracts</span>:{"\n"}
                    {"    - "}
                    <span className="k">address</span>:{" "}
                    <span className="s">&quot;0xA0b8…eB48&quot;</span>
                    {"\n"}
                    {"      "}
                    <span className="k">abi</span>: {"{ "}
                    <span className="k">configMapRef</span>: usdc-abi{" }\n"}
                    {"      "}
                    <span className="k">startBlock</span>: 0
                  </pre>
                </div>
              </div>

              <div className="step">
                <span className="step-no">Step 2</span>
                <h3>The operator provisions</h3>
                <p>
                  A reconcile loop turns the spec into running parts — and heals
                  them.
                </p>
                <div className="flow">
                  <div className="node">Indexer CR — 1 YAML</div>
                  <div className="link">↓ reconciles</div>
                  <div className="node hot">Arckive Operator</div>
                  <div className="link">↓ provisions</div>
                  <div className="node">postgres · schema · worker · read API</div>
                </div>
                <p className="heal">
                  Pod dies? Config drifts? It converges back.
                </p>
              </div>

              <div className="step">
                <span className="step-no">Step 3</span>
                <h3>Query plain SQL</h3>
                <p>
                  Each event is a table in your Postgres. No API between you and
                  your data.
                </p>
                <div className="code">
                  <pre>
                    <span className="c">-- one table per event</span>
                    {"\n"}
                    <span className="k">SELECT</span> &quot;from&quot;,
                    &quot;to&quot;, value{"\n"}
                    <span className="k">FROM</span> usdc_transfer{"\n"}
                    <span className="k">WHERE</span> value &gt; 1000000000{"\n"}
                    <span className="k">ORDER BY</span> block_number{" "}
                    <span className="k">DESC</span>;
                  </pre>
                  <div className="rows">
                    <span className="row">
                      <span>
                        0x3786…39b3 <span className="c">→</span> 0xdbcc…38db
                      </span>
                      <b>3,020.95</b>
                    </span>
                    <span className="row">
                      <span>
                        0xb51a…159a <span className="c">→</span> 0xa7b3…5993
                      </span>
                      <b>3,454.57</b>
                    </span>
                    <span className="row">
                      <span>
                        0x9f21…c04a <span className="c">→</span> 0x53d0…b7da
                      </span>
                      <b>60,884.96</b>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <p className="steps-note">
              ABI in → tables out · empty events list = every event ·{" "}
              <code>startBlock: 0</code> backfills from genesis
            </p>
          </div>
        </section>

        {/* ———— on the shelves now ———— */}
        <section className="section alt shelves">
          <div className="wrap">
            <div className="shelf-head">
              <div>
                <h2>On the shelves now</h2>
                <p className="shelf-sub">
                  Schema <code>idx_usdc_arc</code> · one table per event, typed
                  from the ABI, unique on (block, tx, log).
                </p>
              </div>
              <div className="tabs">
                <span className="tab on">Event tables</span>
                <span className="tab">Control tables</span>
              </div>
            </div>
            <div className="covers scroll-x">
              <Cover
                tint="peach"
                title={
                  <>
                    usdc_
                    <br />
                    transfer
                  </>
                }
                sub="idx_usdc_arc"
                name="usdc_transfer"
                desc={
                  <>
                    Transfer(address,address,uint256)
                    <br />
                    from, to text · value numeric(78,0)
                  </>
                }
              />
              <Cover
                tint="salmon"
                title={
                  <>
                    usdc_
                    <br />
                    approval
                  </>
                }
                sub="idx_usdc_arc"
                name="usdc_approval"
                desc={
                  <>
                    Approval(address,address,uint256)
                    <br />
                    owner, spender text · value numeric(78,0)
                  </>
                }
              />
              <div className="covers-divider" aria-hidden="true" />
              <Cover
                tint="teal"
                title="_cursor"
                sub="control"
                name="_cursor"
                desc={
                  <>
                    last_block, updated_at
                    <br />
                    the checkpoint a restart resumes from
                  </>
                }
              />
              <Cover
                tint="beige"
                title="_meta"
                sub="control"
                name="_meta"
                desc={
                  <>
                    key, value
                    <br />
                    reserved for indexer metadata
                  </>
                }
              />
              <Cover
                tint="outline"
                title={
                  <>
                    _dead_
                    <br />
                    letter
                  </>
                }
                sub="control"
                name="_dead_letter"
                desc={
                  <>
                    logs that failed to decode
                    <br />
                    empty when healthy
                  </>
                }
              />
            </div>
          </div>
        </section>

        {/* ———— 02 reliability ———— */}
        <section id="reliability" className="section">
          <div className="wrap">
            <SecHead n="02" label="Reliability" />
            <h2>Even if the network blips, no data is lost.</h2>

            <div className="rel-grid">
              <div>
                <p className="lede">
                  A poll-based backbone chosen for loss-free, self-healing
                  ingestion — not just latency. Don&apos;t take our word for it:
                  break something.
                </p>
                <div className="mech-list">
                  <div className="mech">
                    <b>Cursor + checkpoint</b>
                    <p>
                      The last processed block lives in Postgres. After any crash
                      it resumes exactly there.
                    </p>
                  </div>
                  <div className="mech">
                    <b>Gap-free backfill</b>
                    <p>
                      Event inserts and cursor advance share one transaction — a
                      commit, or nothing.
                    </p>
                  </div>
                  <div className="mech">
                    <b>Reorg-safe on Arc</b>
                    <p>
                      Indexes to the <code>finalized</code> tag — BFT finality
                      means finalized blocks never reorg.
                    </p>
                  </div>
                  <div className="mech">
                    <b>RPC failover</b>
                    <p>
                      A health-checked pool with rotation, backoff,
                      circuit-breaker. A blip never becomes a gap.
                    </p>
                  </div>
                </div>
              </div>

              <ChaosLab />
            </div>
          </div>
        </section>

        {/* ———— latest events ———— */}
        <section className="section alt">
          <div className="wrap">
            <div className="events-head">
              <h2>Latest events</h2>
              <a href="#how">Open in SQL</a>
            </div>
            <LatestEvents />
          </div>
        </section>

        {/* ———— arc radar ———— */}
        <section id="radar" className="section radar-section">
          <div className="wrap">
            <div className="radar-band">
              <div className="radar-copy">
                <span className="sec-label">Live on Arc</span>
                <h2>Every USDC transfer on Arc, sorted as it lands.</h2>
                <p>
                  Arc Radar files each transfer under swap, bridge, liquidity,
                  payment and more, judged in real time by a small decision
                  model running on one Mac. Ask it a yes/no question and the
                  stream re-sorts while you watch.
                </p>
              </div>
              <a className="btn" href={RADAR}>
                Open Arc Radar <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </section>

        {/* ———— 03 benchmarks ———— */}
        <section id="benchmarks" className="section">
          <div className="wrap">
            <SecHead n="03" label="Benchmarks" />
            <h2>Measured, not promised.</h2>
            <p className="lede">
              Every number comes from running the real worker against the public
              Arc testnet and reading only its production surface — Postgres rows
              and <code>/metrics</code>. Reproduce it with <code>pnpm bench</code>.
            </p>

            <div className="bench-grid">
              <div className="stat">
                <span className="stat-label">block → SQL, p50</span>
                <b>395 ms</b>
                <span>
                  Block close to queryable row on Arc testnet — live USDC
                  traffic, WebSocket <code>newHeads</code> listening, not
                  polling. Even p99 stays under a second (0.97 s).
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">backfill catch-up</span>
                <b>92.6 blocks/s</b>
                <span>
                  5,107 blocks of real USDC history caught up in 55 seconds over
                  a public RPC — about 48× faster than the chain. Zero RPC
                  errors.
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">burst ingest</span>
                <b>2,628 events/s</b>
                <span>
                  The decode + transactional-SQL write ceiling, measured with WAN
                  latency out of the picture.
                </span>
              </div>
            </div>

            <p className="bench-note">
              The budget is published too: the head signal is consumed straight
              from the <code>newHeads</code> payload and one parallel{" "}
              <code>eth_getLogs</code> round-trip later the row is committed. The
              engine itself adds about 40 ms; the rest belongs to how fast the
              RPC announces blocks, and it shrinks further with a cluster-local
              Arc node. Full methodology and raw results:{" "}
              <a href="/benchmarks.html">benchmark report</a> ·{" "}
              <a href={`${REPO}/tree/main/docs/benchmarks`}>docs/benchmarks</a>.
            </p>
          </div>
        </section>

        {/* ———— 04 compare ———— */}
        <section id="compare" className="section alt">
          <div className="wrap">
            <SecHead n="04" label="Compare" />
            <h2>A specific combination nobody else offers.</h2>

            <div className="compare-scroll scroll-x">
              <table className="compare">
                <thead>
                  <tr>
                    <th />
                    <th>Dune</th>
                    <th>The Graph</th>
                    <th>Raw RPC</th>
                    <th className="us">Arckive</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Data in your own DB</td>
                    <td className="they">No</td>
                    <td className="they">Via graph-node</td>
                    <td className="they">If you build it</td>
                    <td className="us">Yes</td>
                  </tr>
                  <tr>
                    <td>Plain SQL access</td>
                    <td className="they">Dune SQL only</td>
                    <td className="they">GraphQL</td>
                    <td className="they">Raw JSON</td>
                    <td className="us">Yes</td>
                  </tr>
                  <tr>
                    <td>Reorg &amp; gap handling</td>
                    <td className="they">Theirs</td>
                    <td className="they">Yes</td>
                    <td className="they">On you</td>
                    <td className="us">Built-in</td>
                  </tr>
                  <tr>
                    <td>Setup effort</td>
                    <td className="they">Low</td>
                    <td className="they">Med–high</td>
                    <td className="they">High</td>
                    <td className="us">One YAML</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="honest">
              <strong>Honest positioning:</strong> Dune stays great for ad-hoc
              analytics; The Graph for hosted multi-chain. Arckive is for teams
              that want their own Postgres, plain SQL, and K8s-native ops —
              together.
            </p>
          </div>
        </section>

        {/* ———— get started ———— */}
        <section id="cta" className="section cta-band">
          <div className="wrap">
            <span className="sec-label">Get started</span>
            <h2>One YAML. A running indexer.</h2>
            <p className="cta-sub">Runs in your cluster. Your data never leaves it.</p>
            <CopyCmd cmd="kubectl apply -f https://arckive.org/install.yaml" />
            <div className="star-ask">
              <p>
                <strong>Arckive is open source and built in the open.</strong>{" "}
                If it saves you a subgraph, a GitHub star is the easiest way to
                help other Arc builders find it.
              </p>
              <StarButton href={REPO} className="btn" />
            </div>
            <p className="meta-line">
              Runs in your cluster · Apache-2.0 · v1alpha1
            </p>
          </div>
        </section>

        {/* ———— footer ———— */}
        <footer className="footer">
          <div className="wrap foot-grid">
            <div className="foot-col">
              <h2>Arckive</h2>
              <p>
                Kubernetes-native event indexer for Arc. Your data never leaves
                your cluster.
              </p>
            </div>
            <div className="foot-col">
              <h2>Product</h2>
              <a href="#how">How it works</a>
              <a href="#reliability">Reliability</a>
              <a href="#benchmarks">Benchmarks</a>
              <a href="#compare">Compare</a>
              <a href={RADAR}>Arc Radar</a>
            </div>
            <div className="foot-col">
              <h2>Documentation</h2>
              <a href={`${REPO}#readme`}>Quickstart</a>
              <a href="/install.yaml">install.yaml</a>
              <a href="/demo.yaml">demo.yaml</a>
              <a href="/benchmarks.html">Benchmark report</a>
            </div>
            <div className="foot-col">
              <h2>Contact</h2>
              <a href={REPO}>GitHub</a>
              <a href={`${REPO}/issues`}>Report an issue</a>
            </div>
          </div>
          <div className="wrap foot-bottom">
            <span>© 2026 Arckive · Apache-2.0</span>
            <span>Kubernetes-native event indexer for Arc · v1alpha1</span>
          </div>
        </footer>
      </main>
    </LiveIndexerProvider>
  );
}
