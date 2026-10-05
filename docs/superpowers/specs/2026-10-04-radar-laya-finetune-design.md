# Fine-tuning Laya for Arc Radar — design

Date: 2026-10-04 · Status: decided in conversation (the user delegated the
design decisions) · Branch: `feat/radar-finetune`

## Goal

Arc Radar's model answers viewers' yes/no questions about transfers better,
without losing what already works, and serves only Arc. The Stellar radar,
which shares today's model, keeps the base checkpoint unchanged.

## Where the headroom is

Measured on 2026-10-04 with `scripts/eval.py` on the fixture (1,200 live
transfers), base `laya-multilingual` (322M, MLX fp16):

| | base |
|---|---|
| Lanes vs the audited fact table | 99.8% (1147/1149) |
| Viewer questions, mean AUC / balanced accuracy (19 of 30 countable) | 0.925 / 0.824 |
| Weakest questions (balanced accuracy) | DeFi 0.51, bridge 0.66, "less than one dollar" 0.68, "more than 100 USDC" 0.70, Turkish bridge 0.69, wallet received 0.75, into a contract 0.76 |
| Rows the control question marks stuck | 0 |
| Gate: answerable refused / nonsense turned away | 0 / 8 of 14 |

The lanes have no headroom, so the lanes are trained only to keep them where
they are. The questions do have headroom: the same day, the larger English
`laya` (421M) answered both amount questions perfectly (1.00 / 1.00) while
losing the lanes (85.9%). That shows the sentence carries the answer and a
model of this kind can learn to read it. The model card says as much: "Laya is a fast
base to specialise, not a zero-shot decision engine" (typed-decisions 0.35 →
0.766 after fine-tuning).

## Out of scope

- The Stellar radar's model, code or gate.
- The insights worker (`feat/laya-insights`). It keeps whatever gate its
  `Indexer` names. The fine-tune keeps lanes intact, but no lane figure is
  claimed for it beyond Arc USDC.
- Rewording lane descriptions, the `shape`/`story` sentences, `RULE_PREFIX`,
  the gate probes or the control question. They are part of the measured
  question.
- A bigger model, cloud training, and histogram-binning calibration (it lives
  only in PyTorch `laya`; layad/MLX never applies it).

## Decisions

| Question | Decision | Why |
|---|---|---|
| What is trained | `noul` viewer questions over `story` (primary), the lane `choice` over `shape` (retention), and a small share of nonsense questions answered "no" | Headroom is in questions; lanes must not drift; nonsense must stay refusable |
| Base | `convaiinnovations/laya-multilingual` at a pinned revision | What runs today; multilingual questions are asked (Turkish is in the eval) |
| Trainer | `laya/train.py` from laya PR #899 at a pinned commit, in a separate venv | The only maintained single-device trainer that picks `mps`, has `soft-ce` and calibration. The radar's runtime deps and Docker image stay torch-free |
| Loss | `soft-ce` on targets smoothed to 0.95/0.05 | Two independent tests (laya #741, PR #899) found soft-CE ≥ RLCD; smoothing keeps confidence from saturating |
| What is frozen | The token-embedding table (≈197M of 322M params) | Our text is English and Turkish. AdamW's weight decay would otherwise shrink the embedding rows of 100+ languages the data never touches. Halves optimizer memory too |
| Option order | Fixed (`shuffle_options` off), `LANES` order exactly | Order is part of the question (moving one option cost 14 points) |
| Control question | Never trained | It is a detector of saturated states; training it to "no" would blind it. Its stuck rate is measured instead |
| Where it runs | A second layad (`:8920`) loading the local checkpoint, Arc's own gate (`:8921`), and a new tunnel hostname `laya-arc.brages.uk` on the existing tunnel | Stellar has no eval, so its model must not change. Arc's calls move off the shared daemon; total GPU work is unchanged |
| Rollback | Dokploy `LAYA_ENDPOINT` back to `https://laya-gate.brages.uk` | The base stays up for Stellar anyway |
| Training on the shared GPU | A supervisor pauses the trainer (`SIGSTOP`/`SIGCONT`) while the shared layad's p95 is above budget | Both radars are live 24/7; a 4×256 test once cost the Stellar radar 1,600 drops |

## Ground truth and leakage

Labels come from the transfer's **reading**: its facts (from the fact table
audited on 2026-09-23), its amount, the kind of each party, mint or burn,
protocol and bridge direction. That is the same source as `eval.py`'s truths,
and the claim stays the same: the model reads its own sentence correctly.
Whether the facts themselves are correct was audited separately.

Two independent paths must agree before any training. The question bank's
truths, computed from the `Summary`, have to match `eval.py`'s truths, computed
from the raw transfer, on every fixture row where both apply. A test enforces
this. In addition, 60 sampled rows (state, question, label) are read by hand
and the reading is recorded in the run manifest.

Separations, each enforced by a test on the built dataset:

1. **Benchmark untouched.** No row comes from the fixture
   (`tests/fixtures/live_sample.json`). No training question is, after
   normalisation, any phrasing from `eval.py` (`QUESTIONS`, `ANSWERABLE`,
   `UNANSWERABLE`, `NONSENSE`), the control question, or a probe.
2. **Held-out topics.** About a third of the question topics (and every one of
   their phrasings) never appear in training.
3. **Held-out phrasings.** Each training topic has 6 English and 3 Turkish
   phrasings; the last 2 English and the last Turkish one never reach training.
4. **Held-out languages.** Spanish, German and Russian phrasings of a few
   topics are never trained. They check that multilingual reading survives,
   Russian covering a non-Latin script.
5. **Time.** The test capture starts after the training capture ends. Its rows
   are reported split into stories seen in training and stories not seen.
   Stories are templated, so most will be seen, and question
   generalisation is the axis that matters.

Truth is only labelled when the story decides it. Amount questions are asked only at the
bucket edges the story states (0.01, 1, 100, 10,000 USDC). "Is it over 50
USDC?" has no label, because "1 to 100 USDC" cannot answer it.

## Data

**States.**
- Training capture: `scripts/capture.py 15000 --every 4 --out …/train.json`
  (~2.6 h at the measured 6.3 transfers/s).
- Test capture: `scripts/capture.py 3000 --every 4 --out …/test.json`, started
  after the training capture ends.
- Synthetic items for coverage. They build fake `Item`s, a transfer plus a
  context whose selector and topics come from `signatures.py`'s tables, and
  run them through the real `summarize()`, so the phrasing is byte-identical
  by construction. They cover what the stream rarely carries: bridges in and
  out, CCTP, vaults, lending, marketplace, payouts, batch payouts, mint, burn,
  dust, zero, unreadable and signed payments, across amount buckets and party
  kinds.
- Synthetic items are training-only; every test figure comes from real
  captures.

**Question bank** (`radar/finetune/questions.py`).
- A topic is a truth function over the reading. Truth may be undefined, in
  which case the row is skipped.
- A training topic has 6 English phrasings and 3 Turkish ones; a held-out
  topic has 3 English and 1 Turkish. Some topics also carry Spanish, German
  and Russian phrasings.
- Each topic and phrasing carries its split: `train`, `heldout-phrasing`,
  `heldout-topic` or `heldout-language`.
- Viewer questions are asked as `RULE_PREFIX + text`, exactly as the server
  asks them.

**Rows** (JSONL in the trainer's `{state, questions, gold}` format).
- Rule rows: a `story` state with 1–8 rule questions, as the server batches
  them. Yes and no are balanced per topic by sampling distinct stories.
- Lane rows: a `shape` state with `LANE_QUESTION` verbatim, labelled with the
  fact-table reading (eval's `reading()`). Only rows the model decides are
  used, never ruled lanes.
- Nonsense rows (≤5% of rows): nonsense questions disjoint from eval's
  `NONSENSE`, labelled "no" on every state.
- Dedup on (state, question). A validation split holds 10% of the training
  *stories* (and their shapes) with training phrasings only. It is used for
  early stopping and temperature fitting. Held-out phrasings, topics and
  languages are never used for model selection, so they stay a clean test.

## Training

- Environment: `radar/finetune/requirements.txt` with exact pins (torch, laya
  at the PR #899 commit SHA, laya-mlx for parity), installed into
  `radar/.venv-ft`.
- Entry point `radar/finetune/train.py`:
  - load the base with laya's `load_checkpoint` and freeze the embedding
    table;
  - call `train_model`. Its optimizer groups already skip parameters with
    `requires_grad=False`;
  - evaluate on validation after each epoch, keep the best epoch, and stop
    after one epoch without improvement;
  - fit temperatures per question type on validation, clamped to [0.5, 5],
    the range the MLX runtime enforces (laya #851/#885);
  - save the checkpoint plus `manifest.json`: base revision, trainer SHA,
    dataset hashes, configuration and metrics.
- Settings: `soft-ce`, encoder lr 2e-5, head lr 1e-4, cosine schedule,
  ≤3 epochs, micro-batch 8 × accumulation 4, the checkpoint's own `max_len`
  1024 / `head_max_len` 256 (padding is to the longest in a batch, and the
  served config stays the base's), fp32 on `mps`, `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.5` (with the low watermark at 0.4: torch refuses a low ratio above the high one). Expected:
  roughly 20–40k rows, 30–90 min, peak ~6 GB.
- Supervisor `radar/finetune/supervise.py`:
  - run the trainer as a child process;
  - before starting, sample the shared layad's `/health` p95 for 2 minutes
    as a baseline;
  - every 5 s, if p95 exceeds max(2 × baseline, 120 ms), stop the child
    (`SIGSTOP`) and resume it (`SIGCONT`) after 30 s back under budget;
  - log pauses and total time paused;
  - a checkpoint after each epoch bounds the loss from a kill.

## Conversion, parity, serving

- Convert with `laya_mlx convert --dtype float16`, the dtype served today.
  layad can also load the PyTorch folder directly, but the fp16 conversion
  makes what is measured and what is served the same file.
- Parity (`radar/finetune/parity.py`) compares PyTorch fp32 and MLX fp16 on
  the validation rows. Lane argmax must agree 100%; the largest probability
  difference must be < 0.02.
- Artifacts live outside git, in
  `~/Library/Application Support/arc-radar/models/laya-multilingual-arc-<YYYYMMDD>-<n>/`.
  layad reports a null revision for a local directory, so the version is
  carried by the folder name.
- LaunchAgents in `radar/scripts/`:
  - `com.arc-radar.model.plist` runs layad on 8920 with `LAYAD_MODEL=<dir>`
    and the MLX cache capped at 1 GiB;
  - `com.arc-radar.gate.plist` runs `radar.modelgate` on 8921 with
    `LAYAD_ENDPOINT=http://127.0.0.1:8920` and the existing `RADAR_TOKEN`.
  They now always run, since Arc has its own model. The README section that
  said to load none of them when Stellar's are up changes accordingly.
- Tunnel:
  - add the ingress rule `laya-arc.brages.uk → http://127.0.0.1:8921` to
    `~/.cloudflared/config.yml` above the 404 catch-all;
  - create the DNS route with `cloudflared tunnel route dns laya-gate
    laya-arc.brages.uk`;
  - restart the tunnel agent, which interrupts the Stellar radar's model calls
    for a few seconds.
- A second netwatch agent (`com.arc-radar.netwatch-arc`) runs the same script
  with its URLs, state file and agent labels set by environment, and may repair
  only the `model` and `gate` layers. The existing instance keeps repairing the
  network and the shared tunnel, so two instances never toggle Wi-Fi.

## Acceptance (base vs fine-tune, same data, same code)

Ship only if all of these hold:

1. **Fixture** (`eval.py`):
   - lanes ≥ 99.5%;
   - mean balanced accuracy over the 30 questions ≥ base;
   - stuck rows = 0;
   - no answerable question refused;
   - nonsense turned away ≥ 8 of 14.
2. **Test capture, held-out phrasings of training topics:** mean balanced
   accuracy ≥ base + 0.05.
3. **Test capture, held-out topics:** mean balanced accuracy ≥ base − 0.02,
   and no single question worse than base by more than 0.05. Gains are
   reported but not required.
4. **Held-out languages and Turkish:** mean balanced accuracy ≥ base − 0.03.
5. **Parity** passes.
6. **Through `https://laya-arc.brages.uk`**, `eval.py` reproduces item 1
   before Dokploy's `LAYA_ENDPOINT` is switched.

The comparison tool (`radar/finetune/report.py`) runs both endpoints on the
fixture, the test capture and the held-out question sets, and prints one table
per item above. The numbers go into the PR and the radar README's accuracy
section.

If items 1–5 fail, nothing is deployed. Record the result in the manifest and
in the radar memory, and treat the next lever as data (more synthetic
coverage, more phrasings), not hyperparameters.

## Testing

- pytest, in the radar venv, no torch needed:
  - truths agree with `eval.py` on the fixture;
  - every topic is defined on the probe stories it should be;
  - synthetic items produce stories that `summarize()` would produce for real
    ones (each fact phrase appears; mint, burn and bridge direction render);
  - leakage separations 1–4 hold on a built dataset;
  - the dataset's JSONL validates against the trainer's row format.
- The trainer wrapper gets a smoke test on a tiny random-weight checkpoint
  (the pattern PR #899's own tests use). It runs in `.venv-ft` only and is
  skipped when torch is absent, so the radar's CI stays torch-free.
- The supervisor's pause logic is unit-tested with a fake health source and a
  fake child.

## Risks

- PR #899 may change or be closed. The commit is pinned; the fallback is
  `research/scripts/finetune_single_device.py` at a pinned SHA, which has the
  same row format.
- MPS training stalls under the supervisor. If paused time exceeds 50% over
  30 minutes, train overnight, when the stream is quietest.
- Overfitting to templated stories: only ~133 distinct stories per 1,200
  transfers. This is mitigated by synthetic coverage, early stopping, the
  frozen embeddings and held-out topics, and acceptance item 3 catches what
  gets through.
- Nonsense rows could teach "unfamiliar → no" and make real held-out topics
  look flat to the gate. Acceptance items 1 and 3 catch it; the fix is fewer
  nonsense rows.
- layad pins `laya-mlx<0.3`. The conversion uses the version layad ships,
  read from its venv, not the latest.
