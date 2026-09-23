# Arc Radar

Every USDC transfer on Arc mainnet, sorted by what it means, as it lands.

Arc Radar reads Arc's live transfer feed, and Laya, a 322M-parameter decision
model, sorts each USDC transfer into a lane — swap, bridge, liquidity, vault,
lending, signed payment, payment — and answers yes/no questions viewers ask
of the stream. Mint-burn, spam and transfers the radar cannot read are
decided by the transfer itself, not the model (see below). No API key and no
per-transfer cost.

## What it reads

USDC is Arc's native currency, so it moves two ways: through the ERC-20
interface at `0x3600…0000`, and natively — a value send, or value passed into
a contract call, which the chain logs as a `Transfer` from the system address
`0xffff…fffe`. The feed reads both. A call through the ERC-20 interface is
logged both ways at once, so each ERC-20 log cancels its native twin. Reading
the ERC-20 interface alone, as the first version did, showed 24% of the USDC
that moved in a measured ten minutes; most of the rest was swaps paid in
native USDC and plain wallet-to-wallet sends.

One kind of transfer is left out on purpose: after every ERC-4337 bundle the
EntryPoint pays the bundler back for gas. That is gas, which a plain
transaction pays with no log at all, and shown it was a sub-cent row on every
smart-account transaction.

## What the model reads

The model does not read a transfer directly. It reads short sentences
describing its **shape**: what kind of party sent to what kind of party
(a wallet — including an EIP-7702 account — or a contract), a bucketed
amount, and plain facts about the rest of the transaction (a swap, a bridge
hop, a batch payout, a smart-account sender, and so on), taken from the
function called and the events logged (`radar/signatures.py`).

There are two sentences, because two different questions are asked. The lane
is read from `shape`. Viewers' questions are read from `story`, which adds
what those questions are about — the size in words ("a medium amount"),
which way a bridge went ("out of Arc"), the protocol — and which, put in the
lane sentence, cost the lanes accuracy.

Addresses never appear in either. Which wallet sent a swap says nothing about
it being a swap, and naming it would split one campaign — the same contract
calling the same function thousands of times — into thousands of distinct
questions instead of one. Because the sentences strip out what doesn't
matter, most of a live batch is text the model has already judged, and
answers are cached per exact sentence.

## What the transfer decides

Three lanes are not a judgement, and the model is not asked:

- **Mint / burn** — one side is the zero address and nothing in the
  transaction says bridge. Offered to the model, this option drew probability
  from every other lane.
- **Spam** — exactly zero USDC moved and nothing else happened. A sub-cent
  transfer is *not* spam on Arc: USDC is gas here, and a sub-cent native send
  is how a new wallet gets some (all 40 recipients of the busiest such sender
  spent it on exactly one transaction).
- **Uncertain** — nothing in the transaction is recognisable, or it could not
  be read. Asked anyway, the model named a lane confidently and arbitrarily
  ("vault" at 0.82, "lending" at 0.64, depending only on wording).

The page marks these rows "rule" or "unread" instead of printing a confidence.

## Measured

The labels the lanes were first measured against came from the same fact
table the model reads, so they were audited before anything else: on ten
minutes of mainnet every reading was checked against what the transaction
actually moved — who gave what, who got what back — and read by hand where
the two disagreed; contract identities were checked against Uniswap's and
Circle's deployments and on chain. That audit, not the model, found most of
what was wrong: the missing native transfers, Relay's same-chain swaps read
as bridges, wrapped USDC read as vaults, EIP-7702 wallets called contracts,
gas refunds filed as spam, and Aerodrome's pools named Uniswap. The full
record is in `docs/superpowers/specs/2026-09-23-arc-radar-accuracy-design.md`.

Against the audited reading, on the same ten minutes (16,632 transfers),
first version against this one:

| | first version | now |
|---|---|---|
| USDC movements on the wall | 24% | all (gas refunds excepted) |
| Lanes agreeing with the evidence | 78.9%, 15.8% uncertain | 99.9%, 0.1% uncertain |
| 24 viewer questions, mean AUC | 0.759 | 0.931 |
| 24 viewer questions, balanced accuracy | 0.641 | 0.834 |

The right lane now carries 0.83 confidence on average. Two later captures
through the real feed, of 1,200 and 4,000 transfers, give 99.8% and 99.9%
lane agreement and 0.832 and 0.823 balanced accuracy (`scripts/eval.py`).

What moved the questions: the story sentence; prefixing every question with
"About this Arc USDC transfer:"; and reading each question at its own yes
line instead of at 0.5, because one question's yeses sit near 0.05 and
another's near 0.9. The line is halfway, in log-odds, between the question's
low and high answers over the gate's probe transfers.

The gate that screens new questions was measured too, and the claim it was
built on did not hold on Arc: polished nonsense does not always answer every
transfer alike. It now turns away only questions that are flat across the
probes — none of the 24 real ones, half of the nonsense — and the page shows
the rest how weakly they sort.

Still weak: questions that make the model compare numbers ("is this less than
one dollar?"), a second protocol in one transaction (a Relay deposit that
swapped on Uniswap reads "Protocol: Relay"), and NFT mints through smart
accounts, which no lane fits.

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

`scripts/capture.py` captures live Arc transfers through the real feed into
the fixture (or `--out` elsewhere); `scripts/eval.py` runs the model over a
capture and reports lane agreement against the evidence, the 24 questions'
AUC and balanced accuracy at the gate's lines, and whether the gate still
tells real questions from nonsense. It keeps every call as small as the
server's own, because the GPU is shared.

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

The model gate on the Mac is published by a Cloudflare Tunnel (`cloudflared
tunnel run laya-gate`) at `https://laya-gate.brages.uk`, which is the default
`LAYA_ENDPOINT` in both the Dockerfile and `docker-compose.yml`. The gate
answers 401 without the bearer `RADAR_TOKEN`. Override `LAYA_ENDPOINT` if the
model is reached another way — `scripts/tunnel.sh` sets up the SSH
reverse-tunnel alternative, which lands the gate on the server's Docker bridge
at `http://172.17.0.1:8919`.

Production runs on Dokploy (project Arckive, service `radar`): repo
`arckive`, branch `main`, build path `/radar`, Dockerfile build, watch path
`radar/**` with autodeploy on, domain `radar.arckive.org` on port 8777 with a
Let's Encrypt certificate. A push to `main` that touches `radar/**` redeploys
it.

`.github/workflows/radar-deploy.yml` is a fallback for when Dokploy's push
webhook is not delivering: it POSTs to the app's deploy webhook, shaped like a
GitHub push event (Dokploy checks the branch, and a bare POST is answered
"Branch Not Match"). It no-ops unless the `DOKPLOY_RADAR_DEPLOY_URL`
repository secret is set.

## Layout

```
radar/arc.py         live USDC transfer feed over RPC, ERC-20 and native
radar/rpc.py         RPC pool with priority fallback
radar/signatures.py  selectors and events -> facts; which protocol handled it
radar/summarize.py   transfer -> shape and story sentences; lanes the transfer decides
radar/classify.py    lane question on shapes, viewer questions on stories, cached
radar/gate.py        screens viewer questions before they reach the model
radar/modelgate.py   authenticating gate in front of the model
radar/sanitize.py    phrases that mark a question as an injection attempt
radar/server.py      pipeline, stats, websocket
web/index.html       the wall
```
