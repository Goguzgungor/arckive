# Arc Radar

Every USDC transfer on Arc mainnet, sorted by what it means, as it lands.

Arc Radar reads Arc's live transfer feed, and Laya, a 322M-parameter decision
model, sorts each USDC transfer into one of nine lanes — swap, bridge,
liquidity, vault, lending, signed payment, payment, mint-burn, spam. No API
key and no per-transfer cost.

## What makes it possible

The model does not read a transfer directly. It reads one short sentence
describing its **shape**: what kind of party sent to what kind of party, a
bucketed amount, and plain facts about the rest of the transaction (a swap
leg, a bridge hop, a smart-account sender, and so on).

Addresses never appear in that sentence. Which wallet sent a swap says nothing
about it being a swap, and naming it would split one campaign — the same
contract calling the same function thousands of times — into thousands of
distinct questions instead of one. Amounts are bucketed rather than dropped
entirely, because a near-zero transfer is the signature of dust spam and that
signal is worth keeping.

Because the shape strips out what doesn't matter, most of a live batch is text
the model has already judged: campaigns repeat one shape over and over, so
answers are cached per exact sentence and reused instead of re-asked.

## Measured

Against live Arc mainnet traffic, full pipeline (feed → shape → model → wall),
28 seconds:

| | |
|---|---|
| Transfers received | 338 (~12/s) |
| Classified | 318 |
| Dropped | 0 |
| Dominant lane | swap, 261/318 |

The raw feed alone (no model in the path) has been seen at 390 transfers in
20 seconds — the model, not the feed, is the pipeline's limit.

Lane agreement, measured against rule-derived labels on 400 captured live
transfers (`scripts/capture.py` + `scripts/eval.py`):

| | |
|---|---|
| Distinct shapes among the 400 | 52 |
| Agreement with rule labels | 358/392 = 91% (bar: 85%) |
| Mean confidence | 0.60 |

The lane wording itself was settled by measurement, not by guessing a
taxonomy: at design time, 384 live transfers collapsed to 74 distinct shapes,
and nine lanes worded in the summary sentence's own phrases ("tokens were
swapped on an exchange", not "a DEX trade occurred") scored 89% against eleven
more abstractly-worded lanes, which scored 4–50%. The model matches vocabulary
more than it reasons about finance, so the lane descriptions were rewritten to
meet it rather than the other way around.

The one residual confusion in the 400-transfer eval is a single repeating
campaign — a bridge deposit routed through a smart account with a swap leg —
which the model answers mint-burn for at only 0.21–0.28 confidence. That is
below the uncertainty floor, so on the live wall it renders as **uncertain**
rather than as a wrong but confident label.

## Running it

The decision model is served by [layad](https://github.com/rcwsr/layad), which
keeps it resident on the GPU:

```bash
LAYAD_MODEL=aac6fef/laya-multilingual-mlx LAYAD_BATCH_SIZE=256 layad serve
```

Then:

```bash
uv venv --python 3.12 && uv pip install -e '.[dev]'
.venv/bin/python -m uvicorn radar.server:app --port 8778
```

Open http://127.0.0.1:8778.

The LaunchAgent that runs the model as a service
(`scripts/com.arc-radar.model.plist`) does not call `layad serve` directly. It
launches Python with a one-line wrapper that caps MLX's GPU buffer cache at
2 GiB (`mx.set_cache_limit(2 * 1024**3)`) before handing off to `layad.cli.main`.
Without that cap the daemon's resident footprint grew to 17 GB on the 24 GB Mac
it runs on — MLX does not release cached buffers on its own — and the model is
shared with another live radar app on the same Mac, so keeping its footprint
bounded matters more here than it would with the whole GPU to itself. For the
same reason, `BATCH_MAX` in `radar/server.py` is capped at 64 transfers per
model call rather than sized for this app's own throughput alone: a large
batch can hold the shared GPU for several seconds and starve the other app's
work.

The LaunchAgents in `scripts/` (`com.arc-radar.model.plist` for layad on
8918, `com.arc-radar.gate.plist` for the gate on 8919, and the tunnel) are
only for a Mac that does not already run them. On a Mac where another radar's
layad and gate already hold 8918 and 8919, load none of them: point
`LAYA_ENDPOINT` at the existing gate and reuse its `RADAR_TOKEN`, since a
second copy would fail to bind those ports or, worse, load the model twice.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LAYA_ENDPOINT` | `http://127.0.0.1:8918` | Where the decision model (or its gate) is reached. |
| `RADAR_TOKEN` | *(none)* | Bearer token sent to the model endpoint. |
| `ARC_RPCS` | the three mainnet endpoints below, in order | Comma-separated RPC pool override. |
| `RADAR_CANONICAL_HOST` | *(none)* | If set, requests for other Host headers are redirected here. |
| `RADAR_REDIRECT_FROM` | *(none)* | Comma-separated hostnames that trigger that redirect. |

Default RPC pool, in priority order: `https://rpc.mainnet.arc.io`,
`https://rpc.blockdaemon.mainnet.arc.io`, `https://rpc.beamrpc.com`.

### Tests and eval

```bash
.venv/bin/pytest -q
```

`scripts/capture.py` captures a fresh sample of live Arc transfers to a fixture
file; `scripts/eval.py` runs the classifier over that fixture and reports lane
agreement against rule-derived labels, the same measurement behind the table
above.

## Deploying

The web app and the model do not have to live on the same machine. The model
stays where the GPU is; the app reads `LAYA_ENDPOINT` and can run anywhere.

Build and run the container:

```bash
cd radar && docker build -t arc-radar:dev .
RADAR_TOKEN=... docker compose up --build
```

The container's healthcheck calls `/healthz`, which answers 503 once no
transfer has arrived for two minutes, so a dead feed marks the container
unhealthy instead of leaving a frozen wall up.

`docker-compose.yml` reaches the Mac's model gate at `172.17.0.1:8919` by
default (the container's Docker bridge address) — override `LAYA_ENDPOINT` if
the model is reached a different way, e.g. through a reverse tunnel to a
remote host's Docker bridge.

Pushing to `main` with changes under `radar/**` triggers a deploy via
`.github/workflows/radar-deploy.yml`, which POSTs to a Dokploy deploy webhook
shaped like a GitHub push event (Dokploy's webhook checks the branch, and a
bare POST is answered "Branch Not Match"). It no-ops if the
`DOKPLOY_RADAR_DEPLOY_URL` repository secret isn't set.

## Layout

```
radar/arc.py         live USDC transfer feed over RPC, reconnecting
radar/rpc.py         RPC pool with priority fallback
radar/summarize.py   transfer -> shape sentence
radar/classify.py    batched lane question, cached per shape
radar/gate.py        screens viewer questions before they reach the model
radar/modelgate.py   authenticating gate in front of the model
radar/sanitize.py    phrases that mark a question as an injection attempt
radar/server.py      pipeline, stats, websocket
web/index.html       the wall
```
