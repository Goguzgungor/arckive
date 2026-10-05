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
| Lanes agreeing with the audited fact table | 78.9%, 15.8% uncertain | 99.9%, 0.1% uncertain |
| 30 viewer questions, mean AUC | 0.657 | 0.944 |
| 30 viewer questions, balanced accuracy | 0.598 | 0.863 |

The lane figure says the model reads its own sentence right — the table's
facts were checked separately, by the audit. The right lane carries 0.83
confidence on average. Question figures average the questions with at least
ten yeses and ten noes in the sample (26 and 29 of 30). Two later captures
through the real feed, of 1,200 and 4,000 transfers, give 99.8% and 99.9%
lane agreement and 0.824 and 0.845 balanced accuracy (`scripts/eval.py`).

What moved the questions: the story sentence; prefixing every question with
"About this Arc USDC transfer:"; and reading each question at its own yes
line instead of at 0.5, because one question's yeses sit near 0.05 and
another's near 0.9. The line is halfway, in log-odds, between the question's
low and high answers over the gate's probe transfers.

The gate that screens new questions was measured too, and the claim it was
built on did not hold on Arc: polished nonsense does not always answer every
transfer alike. It now turns away only questions that are flat across the
probes — none of 37 answerable ones, 8 of 14 nonsense ones, and "is this a
payroll payment?", which nothing on chain records — and the page shows the
rest how weakly they sort, judged in log-odds so that a question whose yeses
all sit near 5% is not called flat.

Still weak: questions that make the model compare numbers ("is this less than
one dollar?"), a second protocol in one transaction (a Relay deposit that
swapped on Uniswap reads "Protocol: Relay"), and NFT mints through smart
accounts, which no lane fits.

### The fine-tuned model

Since 2026-10-04 the radar runs its own fine-tune of `laya-multilingual`
(see "Fine-tuning the model"): run `laya-multilingual-arc-20261004-3`,
blended half way back toward the base (WiSE-FT, `finetune/blend.py`,
alpha 0.5). Base against the shipped model, same code, same data:

| | base | fine-tune |
|---|---|---|
| Fixture lanes (1,149 placed) | 99.8%, right lane at 0.83 | 100.0%, right lane at 0.99 |
| Fixture, 30 questions: mean AUC / balanced accuracy (19 countable) | 0.925 / 0.824 | 0.988 / 0.968 |
| Gate: answerable refused / nonsense turned away | 0 of 37 / 8 of 14 | 0 of 37 / 14 of 14 |
| Test capture, held-out phrasings of taught topics (54) | 0.708 | 0.919 |
| Test capture, topics never taught (36 phrasings) | 0.843 | 0.886 |
| Test capture, Spanish / German / Russian (15) | 0.747 | 0.931 |

The test capture is 3,000 live transfers taken after the training capture
ended; "never taught" topics and phrasings reached training in no form. The
fixture is `eval.py`'s benchmark and never reached training either.

What it does worse than the base, measured: questions about fees and spam it
was never taught keep their ranking ("was a fee charged?" AUC 1.00, "a
worthless spam transfer" 0.93 against 0.99) but the gate's yes line, drawn
from the probes, lands in the wrong place for them, so their highlighted sets
are less accurate (balanced accuracy 0.96 -> 0.86 and 0.89 -> 0.51). "Is this
spam?" is read backwards by both models (AUC 0.19 and 0.25). Turkish is out of
scope for this radar and is not an acceptance criterion. Three full runs and
the blend are recorded in the plan's ledger: the unblended runs taught the
bank harder (balanced accuracy up to 0.990) but read untaught questions worse.

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

Arc's model runs as its own pair of agents, beside the shared model and gate
the Stellar radar uses on 8918 and 8919, which it never touches:
`com.arc-radar.model` serves the fine-tuned checkpoint (see "Fine-tuning the
model") on 8920 with the MLX cache capped at 1 GiB, and `com.arc-radar.gate`
puts the same authenticating gate in front of it on 8921, run from its own
installed copy of the radar in `~/arc-radar`, so checking out another branch
never changes what is serving. Install or refresh both with
`./scripts/install-arc-model.sh <model-dir>`. The gate is published as
`https://laya-arc.brages.uk` by an extra ingress rule on the existing
Cloudflare tunnel, and reuses the shared gate's `RADAR_TOKEN`.

### Staying reachable through outages

launchd restarts the model, the gate or the tunnel if one of them exits, but
not one that hangs, and nothing restarted the network under them: when the
Mac's Wi-Fi dropped for nine and a half hours on 2026-09-29, both radars got
Cloudflare's 530 for every model call until the network came back.

`scripts/netwatch.py` runs every minute from a LaunchAgent and first checks
that the gate answers through the tunnel. If it does not, it repairs the
innermost broken layer, after three bad minutes in a row, with a cooldown
that doubles up to an hour:

| Broken | Seen as | Repair |
|---|---|---|
| model | layad does not answer `/health` | restart the model agent |
| gate | the gate does not answer on loopback | restart the gate agent |
| network | neither 1.1.1.1 nor captive.apple.com answers | turn Wi-Fi off and on (only if it is on) |
| tunnel | the internet answers, the tunnel does not | restart cloudflared |

It cannot fix a router or ISP that is down; then it keeps waiting, and logs
when the model is reachable again. `--dry-run` shows what it would do.
Install or update it with `./scripts/install-netwatch.sh`; it logs to
`~/Library/Logs/arc-radar-netwatch.log`, and only when something is wrong.
Once Arc's own model is installed, the same script also installs a second copy
(`com.arc-radar.netwatch-arc`) that watches `laya-arc.brages.uk` and may
restart only Arc's model and gate; the network and the shared tunnel stay with
the first copy, so two watchdogs never toggle the same Wi-Fi.

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

### Fine-tuning the model

The base model reads transfers well (lanes 99.8%) but answers viewers'
questions less well (balanced accuracy 0.82 on the fixture; amounts, DeFi and
bridges weakest). `finetune/` trains it on Arc's own sentences; the design and
its acceptance bars are in
`docs/superpowers/specs/2026-10-04-radar-laya-finetune-design.md`. Data and
checkpoints live outside git, in `~/Library/Application Support/arc-radar/finetune/`.

```bash
DATA="$HOME/Library/Application Support/arc-radar/finetune/data"
MODELS="$HOME/Library/Application Support/arc-radar/finetune/models"
# 1. capture: training first, the test capture only after it ends
.venv/bin/python scripts/capture.py 15000 --every 4 --out "$DATA/train.json"
.venv/bin/python scripts/capture.py 3000 --every 4 --out "$DATA/test.json"
# 2. the base's own answers to out-of-bank questions (learning without forgetting),
#    then the rows; read audit.md by hand before training on them
.venv/bin/python -m finetune.replay --capture "$DATA/train.json" --out "$DATA/replay.json"
.venv/bin/python -m finetune.dataset --capture "$DATA/train.json" --out "$DATA/rows" --replay "$DATA/replay.json"
# 3. the trainer's own environment (torch + laya PR #899), never the radar's venv
uv venv --python 3.12 .venv-ft && uv pip install --python .venv-ft/bin/python -r finetune/requirements-ft.txt
# 4. train, paused whenever the shared model slows down
RUN="$MODELS/laya-multilingual-arc-$(date +%Y%m%d)-1"; mkdir -p "$RUN"
PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.5 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.4 .venv/bin/python -m finetune.supervise --log "$RUN/train.log" -- \
  .venv-ft/bin/python -m finetune.train --data "$DATA/rows" --out "$RUN"
# 5. blend half way back to the base (WiSE-FT), convert to what layad serves,
#    serve it on 8920, check it answers as trained
.venv-ft/bin/python -m finetune.blend --ft "$RUN/final" --alpha 0.5 --out "$RUN/blend-0.5"
~/.local/share/uv/tools/layad/bin/python -m laya_mlx convert --model "$RUN/blend-0.5" --dtype float16 --output "$RUN/blend-0.5-mlx"
.venv-ft/bin/python -m finetune.parity --model "$RUN/blend-0.5" --endpoint http://127.0.0.1:8920 --rows "$DATA/rows/val.jsonl"
# 6. accept: the fixture, then held-out phrasings, topics and languages on the test capture
LAYA_ENDPOINT=http://127.0.0.1:8920 .venv/bin/python scripts/eval.py
.venv/bin/python -m finetune.report --base http://127.0.0.1:8918 --ft http://127.0.0.1:8920 \
  --capture "$DATA/test.json" --rows "$DATA/rows"
```

The question bank (`finetune/questions.py`) keeps a third of its topics, two
English and one Turkish phrasing of every other topic, and every Spanish,
German and Russian phrasing out of training, and none of `eval.py`'s questions
is ever trained on; tests hold all of it. `finetune/synth.py` adds transfers
the stream rarely carries (lending, bridges into Arc, marketplaces), rendered
by the real `summarize()`; they are training data only.

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

Arc's model gate on the Mac is published by a Cloudflare Tunnel (`cloudflared
tunnel run laya-gate`) at `https://laya-arc.brages.uk`, which is the default
`LAYA_ENDPOINT` in both the Dockerfile and `docker-compose.yml`; the same
tunnel publishes the shared base model's gate, which the Stellar radar uses,
at `https://laya-gate.brages.uk` — pointing `LAYA_ENDPOINT` back there is the
rollback to the base model. The gate
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
