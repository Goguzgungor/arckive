# Fine-tuning Laya for Arc Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fine-tune `laya-multilingual` on Arc's own transfers so the radar answers viewers' yes/no questions better without losing its lanes, gate or languages, and serve it to Arc alone.

**Architecture:** A torch-free `radar/finetune/` package builds labelled rows from captured and synthetic transfers using the radar's own sentence code and a question bank with explicit held-out splits. A separate `.venv-ft` runs laya's PR #899 trainer on MPS under a supervisor that pauses it when the shared model slows down. The result is converted to MLX and served by a second layad (8920) behind Arc's own gate (8921) and the tunnel hostname `laya-arc.brages.uk`. A report compares base and fine-tune on data neither trained on.

**Tech Stack:** Python 3.12, pytest, httpx (radar venv); torch + laya @ PR #899 + huggingface_hub (`.venv-ft`); laya-mlx 0.2 / layad 0.2 (MLX serving); launchd, cloudflared, Dokploy.

**Spec:** `docs/superpowers/specs/2026-10-04-radar-laya-finetune-design.md`

## Global Constraints

- The radar's runtime dependencies and Docker image stay torch-free: nothing is added to `radar/pyproject.toml` `dependencies`.
- Base checkpoint: `convaiinnovations/laya-multilingual` at revision `1720e3e3357cfe1e281542e223f8273b0890ca34`.
- Trainer: `laya @ git+https://github.com/GuilhermeFusari/laya@deb477dc85467c4198009271ebd7a5f07001131d` (laya PR #899 head), installed only in `radar/.venv-ft`.
- `LANES`, `LANE_QUESTION`, `RULE_PREFIX`, `PROBES` and `CONTROL_QUESTION` are imported, never copied or reworded; option order is fixed (`shuffle_options=()`).
- Loss `soft-ce`; targets smoothed to 0.95/0.05; temperatures clamped to [0.5, 5].
- `eval.py`'s fixture, `QUESTIONS`, `ANSWERABLE`, `UNANSWERABLE`, `NONSENSE` and the control question never enter training.
- The shared model and gate (8918/8919, Stellar's agents) are never reconfigured; Arc's model is on 8920, its gate on 8921, its hostname `laya-arc.brages.uk`.
- `RADAR_TOKEN` is never printed, logged or committed.
- Data, checkpoints and logs live outside git under `~/Library/Application Support/arc-radar/finetune/`.
- Repository language is English, comments explain the why, commits follow Conventional Commits, work lands on `main` via PR.

## Review Focus

- A capture where many transactions could not be read (RPC trouble): facts topics must label nothing for them, while amount and party topics still label from the sentence. Pinned in Task 1 (`test_what_the_story_cannot_decide_is_not_labelled`) and Task 3 (`test_unreadable_transfers_only_get_amount_and_party_questions`).
- The supervisor is interrupted (Ctrl-C, or the shell dies) while the trainer is stopped: the trainer must be continued and then terminated, never left stopped holding GPU memory. Pinned in Task 5 (`test_an_interrupted_supervisor_never_leaves_the_trainer_stopped`).
- The shared layad restarts during training and `/health` does not answer: the trainer pauses rather than racing a cold model. Pinned in Task 5 (`test_an_unreachable_model_counts_as_over_budget`).
- Someone passes the benchmark fixture to the dataset builder: it must refuse. Pinned in Task 3 (`test_the_benchmark_fixture_is_refused`).
- A benchmark question re-typed with different case, spacing or punctuation ("bu bir SWAP mı") slips into training: leakage checks compare normalised text. Pinned in Task 1 (`test_normalize_ignores_case_spacing_and_the_question_mark`).

---

## File Structure

| Path | Responsibility |
|---|---|
| `radar/finetune/__init__.py` | Package marker and one-paragraph overview |
| `radar/finetune/questions.py` | `Reading`, topics with truths, phrasings with splits, training nonsense, `normalize` |
| `radar/finetune/synth.py` | Synthetic `Item`s for rare facts and protocols, rendered by the real `summarize()` |
| `radar/finetune/dataset.py` | Rows (`{state, questions, gold}`) + split + stats + audit sheet; CLI |
| `radar/finetune/trainlib.py` | Torch-free training helpers: temperature clamp, validation metrics, best-epoch rule, file hash |
| `radar/finetune/train.py` | The trainer wrapper (runs in `.venv-ft`) |
| `radar/finetune/supervise.py` | Pauses/resumes the trainer by the shared model's p95 |
| `radar/finetune/report.py` | Base vs fine-tune on held-out phrasings/topics/languages; acceptance verdicts |
| `radar/finetune/parity.py` | PyTorch checkpoint vs served MLX answers |
| `radar/finetune/requirements-ft.in` / `.txt` | `.venv-ft` inputs and their compiled pins |
| `radar/tests/test_finetune_*.py` | Tests for each module (radar venv, no torch) |
| `radar/scripts/netwatch.py` | + agent labels and allowed repairs from the environment |
| `radar/scripts/com.arc-radar.model.plist`, `com.arc-radar.gate.plist`, `com.arc-radar.netwatch-arc.plist` | Arc's own model (8920), gate (8921), watchdog |
| `radar/scripts/install-arc-model.sh`, `install-netwatch.sh` | Install/refresh the agents |
| `radar/pyproject.toml` | `pythonpath = ["."]` for pytest |
| `radar/README.md`, `radar/Dockerfile`, `radar/docker-compose.yml`, `.gitignore` | Docs, default endpoint, ignore `.venv-ft/` |

All commands below run from `radar/` in the worktree `/Users/gokbot/Documents/projects/arclight-radar-finetune` unless stated. `DATA="$HOME/Library/Application Support/arc-radar/finetune/data"`, `MODELS="$HOME/Library/Application Support/arc-radar/finetune/models"`.

---

### Task 1: Question bank

**Files:**
- Create: `radar/finetune/__init__.py`, `radar/finetune/questions.py`
- Modify: `radar/pyproject.toml` (`[tool.pytest.ini_options]`)
- Test: `radar/tests/test_finetune_questions.py`

**Interfaces:**
- Produces: `Reading` (frozen dataclass: `readable: bool, facts: frozenset, amount: float, frm: str, to: str, protocol: str, direction: str, plain: bool`); `reading_of(item: Item, summary: Summary) -> Reading`; `TOPICS: dict[str, Topic]`; `truth(topic: str, reading: Reading) -> bool | None`; `Phrasing(topic: str, text: str, lang: str, split: str)`; `phrasings() -> list[Phrasing]`; `NONSENSE_TRAIN: tuple[str, ...]`; `normalize(text: str) -> str`; `forbidden() -> set[str]` (normalised benchmark texts).

- [ ] **Step 1: Make the package importable in tests**

In `radar/pyproject.toml` replace the pytest block with:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
# finetune/ sits beside the radar package, not inside it: it is tooling, not
# runtime, and the Docker image does not need it importable.
pythonpath = ["."]
```

Create `radar/finetune/__init__.py`:

```python
"""Fine-tuning Laya for Arc Radar: the data, the run, and the checks around it.

Everything here except train.py and parity.py runs in the radar's own venv,
with no torch; those two run in .venv-ft. See
docs/superpowers/specs/2026-10-04-radar-laya-finetune-design.md.
"""
```

- [ ] **Step 2: Write the failing tests**

Create `radar/tests/test_finetune_questions.py`:

```python
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval as bench  # noqa: E402
from capture import load  # noqa: E402

from finetune.questions import (  # noqa: E402
    NONSENSE_TRAIN, TOPICS, forbidden, normalize, phrasings, reading_of, truth,
)
from radar.summarize import summarize  # noqa: E402

# eval.py's questions whose truth this bank also defines. Left out: the
# Uniswap question (eval names the venue from addresses, which the story does
# not show when another protocol is named), "a large swap" (two topics at
# once) and the Turkish repeats of English ones.
SAME = {
    "Is this a swap?": "swap",
    "Is this a bridge transfer?": "bridge",
    "Is USDC leaving Arc through a bridge?": "bridge_out",
    "Did these funds arrive from another chain?": "bridge_in",
    "Is this transfer over 10,000 USDC?": "over_10k",
    "Is this more than 100 USDC?": "over_100",
    "Is this less than one dollar?": "under_1",
    "Was it sent by a smart account?": "smart_account",
    "Was a fee taken?": "fee",
    "Is this a direct payment between two wallets?": "direct_payment",
    "Did a wallet receive the USDC?": "to_wallet",
    "Did the USDC go into a contract?": "to_contract",
    "Is this spam or dust?": "spam",
    "Is liquidity being added or removed?": "liquidity",
    "Was USDC minted?": "minted",
    "Is this a gasless signed payment?": "signed",
    "Did this go through CCTP?": "cctp",
    "Is this a DeFi transaction?": "defi",
    "Is this a batch payout to many wallets?": "batch",
    "Is this a vault deposit or withdrawal?": "vault",
    "Were rewards claimed or paid out?": "payout",
    "Was something bought on a marketplace?": "market",
    "Is this a KyberSwap trade?": "kyberswap",
    "Did this go through 1inch?": "oneinch",
    "Was this routed through LI.FI?": "lifi",
}


@pytest.fixture(scope="module")
def fixture_rows():
    return [(it, summarize(it)) for it in load()]


def test_truths_agree_with_eval_wherever_the_story_decides(fixture_rows):
    truths = dict(bench.QUESTIONS)
    checked = 0
    for question, topic in SAME.items():
        for it, s in fixture_rows:
            ours = truth(topic, reading_of(it, s))
            if ours is None:
                continue
            assert ours == truths[question](it, s), (question, s["story"])
            checked += 1
    assert checked > 10_000


def test_one_story_reads_one_way(fixture_rows):
    seen: dict = {}
    for it, s in fixture_rows:
        r = reading_of(it, s)
        for topic in TOPICS:
            seen.setdefault((s["story"], topic), set()).add(truth(topic, r))
    assert all(len(v) == 1 for v in seen.values())


def test_training_topics_hold_back_two_english_and_one_turkish():
    for key, topic in TOPICS.items():
        mine = [p for p in phrasings() if p.topic == key]
        if topic.held_out:
            assert len(topic.en) == 3 and len(topic.tr) == 1, key
            assert {p.split for p in mine if p.lang in ("en", "tr")} == {"heldout-topic"}, key
            continue
        assert len(topic.en) == 6 and len(topic.tr) == 3, key
        split = {(p.lang, p.split): 0 for p in mine}
        for p in mine:
            split[(p.lang, p.split)] += 1
        assert split[("en", "train")] == 4 and split[("en", "heldout-phrasing")] == 2, key
        assert split[("tr", "train")] == 2 and split[("tr", "heldout-phrasing")] == 1, key


def test_other_languages_never_train_and_cover_a_non_latin_script():
    others = [p for p in phrasings() if p.lang not in ("en", "tr")]
    assert {p.split for p in others} == {"heldout-language"}
    assert {"es", "de", "ru"} <= {p.lang for p in others}


def test_about_a_third_of_topics_are_held_out():
    held = sum(t.held_out for t in TOPICS.values())
    assert 0.25 <= held / len(TOPICS) <= 0.4


def test_no_training_question_is_a_benchmark_question():
    banned = forbidden()
    assert normalize("Is this a swap?") in banned
    for p in phrasings():
        if p.split == "train":
            assert normalize(p.text) not in banned, p.text
    for text in NONSENSE_TRAIN:
        assert normalize(text) not in banned, text


def test_every_phrasing_is_unique():
    texts = [normalize(p.text) for p in phrasings()] + [normalize(t) for t in NONSENSE_TRAIN]
    assert len(texts) == len(set(texts))


def test_normalize_ignores_case_spacing_and_the_question_mark():
    assert normalize("  bu bir SWAP  mı ") == normalize("Bu bir swap mı?")
    assert normalize("Is this a swap?!") == normalize("is this a swap")


def test_what_the_story_cannot_decide_is_not_labelled(item):
    unread = item(ctx=False)
    r = reading_of(unread, summarize(unread))
    assert truth("swap", r) is None and truth("cctp", r) is None and truth("spam", r) is None
    # The amount and the two parties are still in the sentence.
    assert truth("over_100", r) is False and truth("to_wallet", r) is True

    nobody = item(contracts={})
    r = reading_of(nobody, summarize(nobody))
    assert truth("to_wallet", r) is None and truth("direct_payment", r) is None

    undirected = item(selector="0xdeadbeef",
                      topics=["0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036"])
    r = reading_of(undirected, summarize(undirected))
    assert truth("bridge", r) is True
    assert truth("bridge_out", r) is None and truth("bridge_in", r) is None
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `.venv/bin/pytest -q tests/test_finetune_questions.py`
Expected: collection error, `ModuleNotFoundError: No module named 'finetune.questions'`.

- [ ] **Step 4: Write `radar/finetune/questions.py`**

```python
"""What the fine-tune asks of a transfer, and which askings it must never see.

A topic is one thing a viewer asks about a transfer -- "did it leave Arc
through a bridge?" -- answered from the transfer's reading: the facts its
story sentence states, the amount, what kind of party sent and received it,
the protocol the story names and which way a bridge went. The story is built
from exactly that reading (radar/summarize.py), so a topic's answer is what
the sentence the model reads can support. Where the sentence cannot decide --
an unknown party, a transaction that could not be read, a bridge with no
direction -- the truth is None and nothing is labelled: a label the sentence
cannot back would teach the model to guess.

Amount topics sit only on the bucket edges the story states (0.01, 1, 100 and
10,000 USDC). "Is it over 50 USDC?" has no topic, because "1 to 100 USDC"
cannot answer it.

Every phrasing carries its split. A training topic's last two English
phrasings and its last Turkish one never reach training; a held-out topic
never reaches training at all; Spanish, German and Russian are never trained.
They are how the report tells learning to read the story apart from learning
these words. See docs/superpowers/specs/2026-10-04-radar-laya-finetune-design.md.
"""
from __future__ import annotations

import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from radar.classify import CONTROL_QUESTION, RULE_PREFIX
from radar.signatures import bridge_direction
from radar.summarize import Summary
from radar.types import DECIMALS, ZERO, Item


@dataclass(frozen=True)
class Reading:
    """What the story sentence states about one transfer."""
    readable: bool          # False: "The rest of the transaction could not be read."
    facts: frozenset
    amount: float           # USDC
    frm: str                # "wallet", "contract", "account" (kind unknown) or "zero"
    to: str
    protocol: str           # as the story names it; "" when it names none
    direction: str          # "out", "in" or "" -- set only for bridges
    plain: bool             # "it was a plain direct transfer"


def _kind(address: str, contracts: dict) -> str:
    if address == ZERO:
        return "zero"
    if address not in contracts:
        return "account"
    return "contract" if contracts[address] else "wallet"


def reading_of(item: Item, summary: Summary) -> Reading:
    t, ctx = item["transfer"], item["ctx"]
    facts = frozenset(summary["facts"])
    return Reading(
        readable=ctx is not None,
        facts=facts,
        amount=t["value"] / 10**DECIMALS,
        frm=_kind(t["frm"], item["contracts"]),
        to=_kind(t["to"], item["contracts"]),
        # summarize() leaves "USDC" out of the story: it tells a question
        # nothing the rest of the sentence does not.
        protocol="" if summary["protocol"] == "USDC" else summary["protocol"],
        direction=bridge_direction(ctx) if "bridge" in facts else "",
        plain=summary["shape"].endswith("it was a plain direct transfer."),
    )


Truth = Callable[[Reading], Optional[bool]]


def _facts(*names: str) -> Truth:
    wanted = frozenset(names)
    return lambda r: bool(r.facts & wanted) if r.readable else None


def _bridge(direction: str) -> Truth:
    def truth(r: Reading) -> Optional[bool]:
        if not r.readable:
            return None
        if "bridge" not in r.facts:
            return False
        return r.direction == direction if r.direction else None
    return truth


def _protocol(name: str, fact: str = "") -> Truth:
    def truth(r: Reading) -> Optional[bool]:
        if not r.readable:
            return None
        return r.protocol == name and (not fact or fact in r.facts)
    return truth


def _party(side: str, kind: str) -> Truth:
    def truth(r: Reading) -> Optional[bool]:
        seen = getattr(r, side)
        return None if seen == "account" else seen == kind
    return truth


def _direct(r: Reading) -> Optional[bool]:
    if not r.readable or "account" in (r.frm, r.to):
        return None
    return r.plain and r.frm == "wallet" and r.to == "wallet"


def _spam(r: Reading) -> Optional[bool]:
    return (r.amount < 0.01 and not r.facts) if r.readable else None


# The same set eval.py's "Is this a DeFi transaction?" reads.
DEFI = ("swap", "liquidity", "vault", "lending", "bridge", "market", "wrap")


@dataclass(frozen=True)
class Topic:
    truth: Truth
    en: tuple
    tr: tuple
    other: tuple = ()        # (lang, text) pairs; never trained
    held_out: bool = False   # the whole topic stays out of training


TOPICS: dict[str, Topic] = {
    # ---- trained: four English and two Turkish phrasings train, the rest are held back
    "swap": Topic(_facts("swap", "market"), (
        "Were tokens swapped in this transaction?", "Did someone trade tokens here?",
        "Is this part of a token swap?", "Was this a trade on an exchange?",
        "Did this transfer come from swapping tokens?", "Is this an exchange trade?",
    ), ("Burada token takası yapıldı mı?", "Bu bir borsa işlemi mi?", "Bu transfer bir takasın parçası mı?"),
        (("es", "¿Es esto un intercambio de tokens?"), ("de", "Ist das ein Token-Tausch?"),
         ("ru", "Это обмен токенов?"))),
    "bridge": Topic(_facts("bridge"), (
        "Did these funds cross chains through a bridge?", "Was a bridge used here?",
        "Is this a cross-chain transfer?", "Did USDC move between blockchains?",
        "Is a bridge involved in this transaction?", "Was this sent across chains?",
    ), ("Bu transfer başka bir zincire köprülendi mi?", "Burada köprü kullanıldı mı?",
        "Bu zincirler arası bir transfer mi?"),
        (("es", "¿Pasó esto por un puente entre cadenas?"), ("de", "Ging das über eine Bridge?"),
         ("ru", "Это перевод через мост между блокчейнами?"))),
    "bridge_out": Topic(_bridge("out"), (
        "Is this USDC leaving Arc for another chain?", "Was USDC bridged out of Arc?",
        "Did the funds go from Arc to a different chain?", "Is money being sent off Arc?",
        "Is USDC being moved off Arc through a bridge?", "Did this transfer exit Arc?",
    ), ("USDC Arc'tan başka bir zincire mi gidiyor?", "Bu para Arc'tan çıkıyor mu?",
        "Fonlar Arc'tan köprüyle mi çıktı?")),
    "bridge_in": Topic(_bridge("in"), (
        "Did this USDC come into Arc from another chain?", "Was USDC bridged into Arc?",
        "Did the funds arrive on Arc through a bridge?", "Is money coming onto Arc from elsewhere?",
        "Did these funds reach Arc from a different blockchain?", "Was this bridged in?",
    ), ("Bu USDC başka bir zincirden Arc'a mı geldi?", "Para Arc'a köprüyle mi girdi?",
        "Fonlar Arc'a dışarıdan mı geldi?")),
    "over_10k": Topic(lambda r: r.amount >= 10_000, (
        "Is this more than 10,000 USDC?", "Was over ten thousand dollars moved?",
        "Is this a large transfer above 10,000 USDC?", "Did more than 10k USDC change hands?",
        "Is the amount above 10,000 USDC?", "Is this a transfer of at least ten thousand USDC?",
    ), ("Bu 10.000 USDC'nin üzerinde mi?", "On bin dolardan fazla mı gönderildi?",
        "Tutar 10.000 USDC'yi aşıyor mu?"),
        (("es", "¿Son más de 10.000 USDC?"), ("de", "Sind das mehr als 10.000 USDC?"),
         ("ru", "Это больше 10 000 USDC?"))),
    "over_100": Topic(lambda r: r.amount >= 100, (
        "Is this over 100 USDC?", "Was more than a hundred dollars sent?",
        "Is the amount at least 100 USDC?", "Did more than 100 USDC move?",
        "Is this transfer above 100 USDC?", "Is it more than a hundred USDC?",
    ), ("Bu 100 USDC'den fazla mı?", "Yüz dolardan fazla mı gönderildi?", "Tutar 100 USDC'nin üstünde mi?")),
    "under_1": Topic(lambda r: r.amount < 1, (
        "Is this under one dollar?", "Was less than 1 USDC sent?",
        "Is the amount below a dollar?", "Did less than one USDC move?",
        "Is this transfer smaller than 1 USDC?", "Is it worth less than a dollar?",
    ), ("Bu bir dolardan az mı?", "1 USDC'den az mı gönderildi?", "Tutar bir doların altında mı?"),
        (("es", "¿Es menos de un dólar?"), ("de", "Ist das weniger als ein Dollar?"),
         ("ru", "Это меньше одного доллара?"))),
    "under_cent": Topic(lambda r: r.amount < 0.01, (
        "Is this less than one cent?", "Was a fraction of a cent sent?",
        "Is the amount below 0.01 USDC?", "Is this a dust amount?",
        "Did less than a cent of USDC move?", "Is this a tiny dust transfer?",
    ), ("Bu bir sentten az mı?", "Gönderilen miktar toz kadar küçük mü?", "Tutar 0,01 USDC'nin altında mı?")),
    "zero_amount": Topic(lambda r: r.amount == 0, (
        "Was zero USDC sent?", "Is the amount exactly zero?",
        "Did no USDC actually move?", "Is this a zero-value transfer?",
        "Was nothing transferred in value?", "Is this an empty transfer of 0 USDC?",
    ), ("Sıfır USDC mi gönderildi?", "Tutar tam olarak sıfır mı?", "Bu sıfır değerli bir transfer mi?")),
    "direct_payment": Topic(_direct, (
        "Is this a plain payment from one wallet to another?", "Did one wallet simply pay another?",
        "Is this a simple wallet-to-wallet transfer?", "Was USDC sent directly between two people's wallets?",
        "Is this just a direct transfer between wallets?", "Did a wallet send USDC straight to another wallet?",
    ), ("Bu bir cüzdandan diğerine düz bir ödeme mi?", "Bir cüzdan diğerine doğrudan mı ödedi?",
        "Bu basit bir cüzdandan cüzdana transfer mi?")),
    "to_wallet": Topic(_party("to", "wallet"), (
        "Did the USDC end up in a wallet?", "Is the recipient a wallet?",
        "Was this sent to a personal wallet?", "Did a person's wallet get the funds?",
        "Is the receiver a wallet rather than a contract?", "Did the money go to a wallet?",
    ), ("USDC bir cüzdana mı gitti?", "Alıcı bir cüzdan mı?", "Para bir cüzdana mı gönderildi?"),
        (("es", "¿Recibió los USDC una billetera?"), ("de", "Hat eine Wallet die USDC erhalten?"),
         ("ru", "Получил ли USDC кошелёк?"))),
    "to_contract": Topic(_party("to", "contract"), (
        "Was the USDC sent to a contract?", "Is the recipient a smart contract?",
        "Did a contract receive the funds?", "Did the money go into a contract?",
        "Is the receiver a contract rather than a wallet?", "Did this transfer land in a smart contract?",
    ), ("USDC bir kontrata mı gönderildi?", "Alıcı bir akıllı kontrat mı?", "Para bir kontrata mı gitti?")),
    "from_wallet": Topic(_party("frm", "wallet"), (
        "Did the USDC come from a wallet?", "Is the sender a wallet?",
        "Was this sent by a personal wallet?", "Did a wallet pay this?",
        "Is the sender a wallet rather than a contract?", "Did the funds leave a wallet?",
    ), ("USDC bir cüzdandan mı geldi?", "Gönderen bir cüzdan mı?", "Para bir cüzdandan mı çıktı?")),
    "from_contract": Topic(_party("frm", "contract"), (
        "Did the USDC come from a contract?", "Is the sender a smart contract?",
        "Did a contract pay out these funds?", "Was this sent by a contract?",
        "Is the sender a contract rather than a wallet?", "Did the money leave a contract?",
    ), ("USDC bir kontrattan mı geldi?", "Gönderen bir akıllı kontrat mı?", "Para bir kontrattan mı çıktı?")),
    "minted": Topic(lambda r: r.frm == "zero", (
        "Was new USDC created here?", "Is this a USDC mint?",
        "Did new USDC come into existence?", "Was USDC issued in this transaction?",
        "Were fresh USDC tokens minted?", "Is this USDC being minted?",
    ), ("Yeni USDC basıldı mı?", "Bu bir USDC basımı mı?", "Bu işlemde USDC mi basıldı?")),
    "burned": Topic(lambda r: r.to == "zero", (
        "Was USDC destroyed here?", "Is this a USDC burn?",
        "Did USDC go out of existence?", "Was USDC burned in this transaction?",
        "Were USDC tokens burned?", "Is this USDC being burned?",
    ), ("USDC yakıldı mı?", "Bu bir USDC yakımı mı?", "Bu işlemde USDC mi yakıldı?")),
    "signed": Topic(_facts("signed"), (
        "Did the payer sign an authorization that someone else submitted?", "Was this a gasless payment?",
        "Is this a signed transfer submitted by a third party?", "Did someone else pay the gas for this payment?",
        "Was this payment authorized by signature?", "Is this a meta-transaction payment?",
    ), ("Ödeyen bir yetki imzalayıp başkası mı gönderdi?", "Bu gazsız bir ödeme mi?",
        "Bu ödeme imzayla mı yetkilendirildi?")),
    "defi": Topic(_facts(*DEFI), (
        "Is this a DeFi operation?", "Was a DeFi protocol involved?",
        "Is this decentralized finance activity?", "Did this use a DeFi app?",
        "Is this transfer part of DeFi?", "Did a DeFi protocol handle this?",
    ), ("Bu bir DeFi işlemi mi?", "Burada bir DeFi protokolü kullanıldı mı?", "Bu transfer DeFi'nin bir parçası mı?")),
    "vault": Topic(_facts("vault"), (
        "Were funds deposited into a vault?", "Did money go in or out of a vault?",
        "Is this a vault deposit?", "Was a vault used here?",
        "Did someone deposit into or withdraw from a vault?", "Is a vault involved?",
    ), ("Fonlar bir kasaya mı yatırıldı?", "Burada bir vault kullanıldı mı?",
        "Bu bir vault yatırma ya da çekme işlemi mi?")),
    "lending": Topic(_facts("lending"), (
        "Was a loan involved?", "Did someone borrow or repay?",
        "Is this a lending operation?", "Was a loan opened, repaid or liquidated?",
        "Is this borrowing or lending?", "Did a lending protocol handle this?",
    ), ("Burada bir kredi var mı?", "Biri borç aldı ya da ödedi mi?", "Bu bir borç verme işlemi mi?")),
    "wrap": Topic(_facts("wrap"), (
        "Was USDC wrapped or unwrapped?", "Did someone wrap USDC?",
        "Is this a wrapping of USDC?", "Was wrapped USDC involved?",
        "Did USDC get wrapped here?", "Was USDC unwrapped?",
    ), ("USDC sarmalandı mı?", "Burada USDC wrap edildi mi?", "Wrapped USDC kullanıldı mı?")),
    "cctp": Topic(_protocol("CCTP"), (
        "Was CCTP used?", "Did Circle's CCTP move this?",
        "Is this a CCTP transfer?", "Did this use the Cross-Chain Transfer Protocol?",
        "Was this routed via CCTP?", "Is CCTP behind this transfer?",
    ), ("CCTP kullanıldı mı?", "Bu bir CCTP transferi mi?", "Bu Circle CCTP ile mi gönderildi?")),
    "relay": Topic(_protocol("Relay"), (
        "Was Relay used?", "Did this go through Relay?",
        "Is this a Relay transfer?", "Did the Relay protocol handle this?",
        "Was this bridged with Relay?", "Is Relay behind this transaction?",
    ), ("Relay kullanıldı mı?", "Bu Relay üzerinden mi geçti?", "Bu bir Relay transferi mi?")),
    # ---- held out: never trained, only measured
    "smart_account": Topic(_facts("smart_account"), (
        "Was this sent from a smart account?", "Did an ERC-4337 smart account send this?",
        "Is the sender using a smart account?",
    ), ("Bu bir akıllı hesaptan mı gönderildi?",), held_out=True),
    "fee": Topic(_facts("fee"), (
        "Was a fee charged?", "Did someone take a fee here?", "Was a commission paid?",
    ), ("Burada bir ücret alındı mı?",), held_out=True),
    "liquidity": Topic(_facts("liquidity"), (
        "Did pool liquidity change?", "Was liquidity added to a pool?", "Is this a liquidity provision?",
    ), ("Havuz likiditesi değişti mi?",), held_out=True),
    "batch": Topic(_facts("batch"), (
        "Was this a batch of payments to many recipients?", "Did one sender pay many wallets at once?",
        "Is this a mass payout?",
    ), ("Bu birçok alıcıya toplu bir ödeme mi?",), held_out=True),
    "payout": Topic(_facts("payout"), (
        "Were rewards claimed?", "Is this a payout or reward distribution?", "Did someone claim a reward?",
    ), ("Ödül mü talep edildi?",), held_out=True),
    "market": Topic(_facts("market"), (
        "Were tokens bought or sold on a marketplace?", "Is this an NFT marketplace sale?",
        "Did a marketplace order get filled?",
    ), ("Bir pazar yerinde alım satım mı yapıldı?",), held_out=True),
    "spam": Topic(_spam, (
        "Is this spam?", "Is this a worthless spam transfer?", "Is this junk dust with nothing else happening?",
    ), ("Bu bir spam transfer mi?",), held_out=True),
    "uniswap": Topic(_protocol("Uniswap", "swap"), (
        "Did this trade happen on Uniswap?", "Was Uniswap used for this swap?", "Is this a swap on Uniswap?",
    ), ("Bu takas Uniswap'te mi yapıldı?",), held_out=True),
    "aerodrome": Topic(_protocol("Aerodrome", "swap"), (
        "Was this traded on Aerodrome?", "Did Aerodrome handle this swap?", "Is this an Aerodrome swap?",
    ), ("Bu takas Aerodrome'da mı yapıldı?",), held_out=True),
    "okx": Topic(_protocol("OKX DEX"), (
        "Was OKX DEX used?", "Did this go through OKX?", "Is this an OKX DEX swap?",
    ), ("Bu OKX DEX üzerinden mi geçti?",), held_out=True),
    "kyberswap": Topic(_protocol("KyberSwap"), (
        "Was this traded on KyberSwap?", "Did KyberSwap handle this?", "Is KyberSwap involved?",
    ), ("Bu KyberSwap'te mi işlem gördü?",), held_out=True),
    "oneinch": Topic(_protocol("1inch"), (
        "Was 1inch used?", "Did the 1inch router handle this?", "Is this a 1inch swap?",
    ), ("Bu 1inch ile mi yapıldı?",), held_out=True),
    "lifi": Topic(_protocol("LI.FI"), (
        "Was LI.FI used?", "Did LI.FI route this?", "Is this a LI.FI transfer?",
    ), ("Bu LI.FI üzerinden mi geçti?",), held_out=True),
}


@dataclass(frozen=True)
class Phrasing:
    topic: str
    text: str
    lang: str
    split: str   # "train", "heldout-phrasing", "heldout-topic" or "heldout-language"


def phrasings() -> list[Phrasing]:
    out: list[Phrasing] = []
    for key, topic in TOPICS.items():
        if topic.held_out:
            out += [Phrasing(key, t, "en", "heldout-topic") for t in topic.en]
            out += [Phrasing(key, t, "tr", "heldout-topic") for t in topic.tr]
        else:
            out += [Phrasing(key, t, "en", "train" if i < len(topic.en) - 2 else "heldout-phrasing")
                    for i, t in enumerate(topic.en)]
            out += [Phrasing(key, t, "tr", "train" if i < len(topic.tr) - 1 else "heldout-phrasing")
                    for i, t in enumerate(topic.tr)]
        out += [Phrasing(key, t, lang, "heldout-language") for lang, t in topic.other]
    return out


def truth(topic: str, reading: Reading) -> Optional[bool]:
    return TOPICS[topic].truth(reading)


# Questions nothing on chain answers, always labelled "no", so polished
# nonsense keeps answering every transfer alike and the gate keeps refusing
# it. None of them is eval.py's NONSENSE list, which stays a clean test, and
# none of them is about singing: the control question asks that, and it must
# stay a detector rather than a trained answer.
NONSENSE_TRAIN = (
    "is the sender wearing glasses?", "did this transfer enjoy the weekend?", "is the recipient a good dancer?",
    "does this payment prefer tea or coffee?", "was this transfer written in a poem?",
    "is the blockchain feeling tired?", "did a unicorn sign this?", "is the sender's favourite colour green?",
    "does the recipient play the piano?", "was this sent during a full moon?", "is this transfer afraid of the dark?",
    "does the USDC smell of roses?", "did the wallet watch a movie today?", "is the contract in love?",
    "does this transaction speak French?", "was the sender born in winter?", "is the recipient taller than six feet?",
    "did a cat walk across the keyboard?", "does this block have a garden?", "is the wallet hungry?",
    "did the payment go to the beach?", "is this transaction a vegetarian?", "does the sender have a brother?",
    "was this transfer painted blue?", "is the recipient good at chess?", "did this transfer win a race?",
    "does the contract like football?", "is the amount feeling lucky?", "did a ghost send this?",
    "gönderen gözlük takıyor mu?", "bu transfer hafta sonunu sevdi mi?", "alıcı iyi dans eder mi?",
)


def normalize(text: str) -> str:
    """The text two askings share when they are the same question."""
    text = unicodedata.normalize("NFKC", text).casefold().strip()
    text = re.sub(r"[?!.？！。]+$", "", text)
    return re.sub(r"\s+", " ", text).strip()


def forbidden() -> set[str]:
    """Every benchmark asking, normalised: none of these may be trained on."""
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    import eval as bench  # scripts/eval.py; imported late so this module loads without it

    texts = [q for q, _ in bench.QUESTIONS] + bench.ANSWERABLE + bench.UNANSWERABLE + bench.NONSENSE
    texts.append(CONTROL_QUESTION["instructions"])
    return {normalize(t) for t in texts} | {normalize(RULE_PREFIX + t) for t in texts}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `.venv/bin/pytest -q tests/test_finetune_questions.py`
Expected: all pass. If `test_truths_agree_with_eval_wherever_the_story_decides` fails, read the failing story: either the bank's truth reads the sentence differently from eval (fix the bank), or eval's truth is not readable from the sentence (then the question belongs in the "Left out" comment, with the reason).

- [ ] **Step 6: Commit**

```bash
git add radar/pyproject.toml radar/finetune/__init__.py radar/finetune/questions.py radar/tests/test_finetune_questions.py
git commit -m "feat(radar): question bank for the fine-tune, with held-out splits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Synthetic transfers

**Files:**
- Create: `radar/finetune/synth.py`
- Test: `radar/tests/test_finetune_synth.py`

**Interfaces:**
- Consumes: `radar.summarize.summarize`, `radar.signatures` tables.
- Produces: `RECIPES: list[Recipe]`; `items() -> list[Item]` (deterministic; each `Item` has `seen_at = 0.0`).

- [ ] **Step 1: Write the failing tests**

Create `radar/tests/test_finetune_synth.py`:

```python
from finetune import synth
from radar.signatures import FACT_ORDER
from radar.summarize import summarize

# recipe -> (facts, protocol as summarize() names it, bridge direction word in the story)
EXPECT = {
    "uniswap_swap": (["swap"], "Uniswap", ""),
    "uniswap_swap_fee": (["swap", "fee"], "Uniswap", ""),
    "okx_swap_fee": (["swap", "fee"], "OKX DEX", ""),
    "kyber_swap": (["swap"], "KyberSwap", ""),
    "oneinch_swap": (["swap"], "1inch", ""),
    "zerox_swap": (["swap"], "0x", ""),
    "aerodrome_swap": (["swap"], "Aerodrome", ""),
    "launchpad_buy": (["swap"], "", ""),
    "cctp_out": (["bridge"], "CCTP", "(out of Arc)"),
    "cctp_in": (["bridge"], "CCTP", "(into Arc)"),
    "relay_out": (["bridge"], "Relay", "(out of Arc)"),
    "relay_swap_out": (["bridge", "swap"], "Relay", "(out of Arc)"),
    "lifi_out_fee": (["bridge", "fee"], "LI.FI", "(out of Arc)"),
    "across_fill_in": (["bridge"], "", "(into Arc)"),
    "intent_fill_in": (["bridge"], "", "(into Arc)"),
    "liquidity_v4": (["liquidity"], "Uniswap", ""),
    "liquidity_v3": (["liquidity"], "", ""),
    "liquidity_aerodrome": (["liquidity"], "Aerodrome", ""),
    "vault_deposit": (["vault"], "", ""),
    "vault_withdraw": (["vault"], "", ""),
    "wrap": (["wrap"], "", ""),
    "wrap_swap": (["swap", "wrap"], "Uniswap", ""),
    "lending_borrow": (["lending"], "", ""),
    "lending_repay": (["lending"], "", ""),
    "seaport": (["market"], "", ""),
    "disperse": (["batch"], "", ""),
    "claim": (["payout"], "", ""),
    "signed": (["signed"], "USDC", ""),
    "smart_account": (["smart_account"], "", ""),
    "smart_account_swap": (["swap", "smart_account"], "", ""),
    "plain_erc20": ([], "USDC", ""),
    "plain_native": ([], "USDC", ""),
    "unknown_call": ([], "", ""),
    "unreadable": ([], "", ""),
    "issuance_mint": ([], "USDC", ""),
    "issuance_burn": ([], "USDC", ""),
}


def _first(name):
    return next(it for it, r in synth.labelled() if r == name)


def test_every_recipe_reads_as_intended():
    assert set(EXPECT) == {r.name for r in synth.RECIPES}
    for name, (facts, protocol, direction) in EXPECT.items():
        s = summarize(_first(name))
        assert s["facts"] == facts, name
        assert s["protocol"] == protocol, name
        if direction:
            assert direction in s["story"], name


def test_the_stories_cover_every_fact_and_named_protocol():
    stories = [summarize(it) for it in synth.items()]
    assert set(FACT_ORDER) <= {f for s in stories for f in s["facts"]}
    named = {s["protocol"] for s in stories}
    assert {"CCTP", "Relay", "LI.FI", "OKX DEX", "KyberSwap", "1inch", "0x", "Uniswap", "Aerodrome"} <= named


def test_mint_burn_plain_and_unreadable_render():
    stories = {summarize(it)["story"].split(",")[0] for it in synth.items()}
    assert "USDC was minted to a wallet" in stories and "USDC was burned from a contract" in stories
    texts = [summarize(it)["story"] for it in synth.items()]
    assert any(t.endswith("it was a plain direct transfer.") for t in texts)
    assert any("could not be read" in t for t in texts)
    assert any("amount zero USDC" in t for t in texts)
    assert any("(a large amount)" in t for t in texts)


def test_items_are_deterministic():
    assert synth.items() == synth.items()
```

(`synth.labelled()` yields `(item, recipe_name)` pairs.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `.venv/bin/pytest -q tests/test_finetune_synth.py`
Expected: `ImportError: cannot import name 'synth' from 'finetune'`.

- [ ] **Step 3: Write `radar/finetune/synth.py`**

```python
"""Transfers the live stream rarely carries, built so the radar's own code reads them.

Ten minutes of mainnet is mostly swap legs; lending has not been seen on Arc
at all, and bridges into Arc are a handful an hour. A question about them
would have almost nothing to learn from. These recipes are the transaction
kinds the fact table knows -- the selector called, the events logged, the
contract addressed -- and every synthetic transfer goes through the real
summarize(), so its sentences are the radar's own, byte for byte. They are
training data only: every figure the report gives comes from real captures.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Optional

from radar.types import USDC, ZERO, Item

UR = "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1"                 # Uniswap Universal Router
POSITION_MANAGER = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b"   # Uniswap v4 PositionManager
AERODROME_FACTORY = "0xb89df768af2cfe637ceb352c587fe8edaf491d03"

SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
HOOK_FEE = "0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d"
OKX_FEE = "0x7970b0744fdb6cf0b120e5e0a5f4da3ab8cbec6d5d9ec8a4f327ccc1d8a5eb8b"
RELAY_DEPOSIT = "0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1"
LIFI_STARTED = "0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1"
FEES_FORWARDED = "0x3a7029951ba36c1af37954df919ce2f9a95c3f5c2c2e872d5e7fd47c61a6df26"
INCREASE_LIQUIDITY = "0x0f8712c47eb813e705bf827a60bdd551e6f2e055b4a1c2004304d52208a5a513"
MINT_V3 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"
ERC4626_DEPOSIT = "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7"
ERC4626_WITHDRAW = "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db"
WRAP_DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"
WRAP_WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65"
BORROW = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0"
REPAY = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051"
ORDER_FULFILLED = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31"
CLAIMED = "0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683"
AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"
USER_OP = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"

UNKNOWN = "0xdeadbeef"   # a selector the fact table does not know


@dataclass(frozen=True)
class Recipe:
    name: str
    selector: str
    topics: tuple = ()
    to: Optional[str] = None            # tx.to; another contract when None
    pool_factory: Optional[str] = None  # the factory that deployed the pool emitting `topics`
    mint: bool = False                  # the transfer comes from the zero address
    burn: bool = False                  # the transfer goes to the zero address
    readable: bool = True


RECIPES = [
    Recipe("uniswap_swap", "0x3593564c", (SWAP_V3,), to=UR),
    Recipe("uniswap_swap_fee", "0x3593564c", (SWAP_V3, HOOK_FEE), to=UR),
    Recipe("okx_swap_fee", "0x0c307f76", (OKX_FEE,)),
    Recipe("kyber_swap", "0xe21fd0e9"),
    Recipe("oneinch_swap", "0x07ed2379"),
    Recipe("zerox_swap", "0x2213bc0b"),
    Recipe("aerodrome_swap", "0x38ed1739", (SWAP_V3,), pool_factory=AERODROME_FACTORY),
    Recipe("launchpad_buy", "0x2afaca20"),
    Recipe("cctp_out", "0x8e0250ee", burn=True),
    Recipe("cctp_in", "0x57ecfd28", mint=True),
    Recipe("relay_out", UNKNOWN, (RELAY_DEPOSIT,)),
    Recipe("relay_swap_out", "0x3593564c", (SWAP_V3, RELAY_DEPOSIT), to=UR),
    Recipe("lifi_out_fee", UNKNOWN, (LIFI_STARTED, FEES_FORWARDED)),
    Recipe("across_fill_in", "0xdeff4b24"),
    Recipe("intent_fill_in", "0x7e7fc653"),
    Recipe("liquidity_v4", "0xdd46508f", to=POSITION_MANAGER),
    Recipe("liquidity_v3", UNKNOWN, (INCREASE_LIQUIDITY,)),
    Recipe("liquidity_aerodrome", UNKNOWN, (MINT_V3,), pool_factory=AERODROME_FACTORY),
    Recipe("vault_deposit", UNKNOWN, (ERC4626_DEPOSIT,)),
    Recipe("vault_withdraw", UNKNOWN, (ERC4626_WITHDRAW,)),
    Recipe("wrap", UNKNOWN, (WRAP_DEPOSIT,)),
    Recipe("wrap_swap", "0x3593564c", (SWAP_V3, WRAP_WITHDRAWAL), to=UR),
    Recipe("lending_borrow", UNKNOWN, (BORROW,)),
    Recipe("lending_repay", UNKNOWN, (REPAY,)),
    Recipe("seaport", "0x87201b41", (ORDER_FULFILLED,)),
    Recipe("disperse", "0xc73a2d60"),
    Recipe("claim", "0x4e71d92d", (CLAIMED,)),
    Recipe("signed", "0xe3ee160e", (AUTH_USED,), to=USDC),
    Recipe("smart_account", "0x765e827f", (USER_OP,)),
    Recipe("smart_account_swap", "0x765e827f", (SWAP_V3, USER_OP)),
    Recipe("plain_erc20", "0xa9059cbb", to=USDC),
    Recipe("plain_native", "0x"),
    Recipe("unknown_call", "0x12345678"),
    Recipe("unreadable", UNKNOWN, readable=False),
    Recipe("issuance_mint", "0x40c10f19", to=USDC, mint=True),
    Recipe("issuance_burn", "0x42966c68", to=USDC, burn=True),
]

# One raw value (6 decimals) per amount bucket summarize() names:
# zero, dust, under a dollar, small, medium, large.
AMOUNTS = (0, 4_000, 500_000, 25_000_000, 2_500_000_000, 50_000_000_000)

WALLETS = ("0x" + "a1" * 20, "0x" + "a2" * 20)
CONTRACTS = ("0x" + "c1" * 20, "0x" + "c2" * 20)
POOL = "0x" + "b1" * 20
EMITTER = "0x" + "e1" * 20
ELSEWHERE = "0x" + "c9" * 20
KNOWN = {**{w: False for w in WALLETS}, **{c: True for c in CONTRACTS}}
PARTIES = (("wallet", "contract"), ("contract", "wallet"), ("contract", "contract"), ("wallet", "wallet"))


def _address(kind: str, slot: int) -> str:
    return ZERO if kind == "zero" else (WALLETS if kind == "wallet" else CONTRACTS)[slot]


def _item(recipe: Recipe, frm_kind: str, to_kind: str, value: int, n: int) -> Item:
    frm, to = _address(frm_kind, 0), _address(to_kind, 1)
    ctx = None
    if recipe.readable:
        ctx = {
            "to": recipe.to or ELSEWHERE,
            "selector": recipe.selector,
            "topics": list(recipe.topics),
            "sender": frm if frm != ZERO else WALLETS[0],
            "emitters": [POOL if recipe.pool_factory else EMITTER for _ in recipe.topics],
            "factories": {POOL: recipe.pool_factory} if recipe.pool_factory else {},
        }
    return {
        "transfer": {"tx": "0x%064x" % n, "log_index": 0, "block": 0, "frm": frm, "to": to, "value": value},
        "ctx": ctx,
        "contracts": dict(KNOWN),
        "seen_at": 0.0,
    }


def labelled() -> Iterator[tuple[Item, str]]:
    """Every synthetic transfer with the recipe it came from, in a fixed order."""
    n = 0
    for recipe in RECIPES:
        if recipe.mint:
            pairs = (("zero", "wallet"), ("zero", "contract"))
        elif recipe.burn:
            pairs = (("wallet", "zero"), ("contract", "zero"))
        else:
            pairs = PARTIES
        for frm_kind, to_kind in pairs:
            for value in AMOUNTS:
                n += 1
                yield _item(recipe, frm_kind, to_kind, value, n), recipe.name


def items() -> list[Item]:
    return [it for it, _ in labelled()]
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `.venv/bin/pytest -q tests/test_finetune_synth.py`
Expected: all pass. A recipe whose facts or protocol differ from `EXPECT` means the recipe does not say what the fact table needs; fix the recipe, never `EXPECT`.

- [ ] **Step 5: Commit**

```bash
git add radar/finetune/synth.py radar/tests/test_finetune_synth.py
git commit -m "feat(radar): synthetic transfers for the facts the stream rarely carries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Dataset builder

**Files:**
- Create: `radar/finetune/dataset.py`
- Modify: `.gitignore` (add `.venv-ft/`)
- Test: `radar/tests/test_finetune_dataset.py`

**Interfaces:**
- Consumes: `finetune.questions` (Task 1), `finetune.synth.items()` (Task 2), `scripts/eval.py` `reading`, `scripts/capture.py` `load`/`FIXTURE`, `radar.classify` `LANE_QUESTION`, `LANES`, `RULE_PREFIX`, `rule_question`.
- Produces: `build(items, seed=0) -> {"train": [row], "val": [row]}` where `row = {"state": str, "questions": {qid: question}, "gold": {qid: {"probabilities": {...}}}}`; rule qids are `"<topic>.<k>"`, nonsense qids `"nonsense.<k>"`, the lane qid `"lane"`; `is_val(state) -> bool`; `stats(rows) -> dict`; `audit(rows, seed) -> str`; `main(argv) -> int` writing `train.jsonl`, `val.jsonl`, `stats.json`, `audit.md`.

- [ ] **Step 1: Write the failing tests**

Create `radar/tests/test_finetune_dataset.py`:

```python
import json

import pytest

from finetune import dataset, synth
from finetune.questions import NONSENSE_TRAIN, TOPICS, forbidden, normalize, phrasings, reading_of, truth
from radar.classify import LANE_QUESTION, LANES, RULE_PREFIX
from radar.summarize import summarize


@pytest.fixture(scope="module")
def rows():
    return dataset.build(synth.items())


def _questions(rows):
    for split, part in rows.items():
        for row in part:
            for qid, q in row["questions"].items():
                yield split, row, qid, q


def test_rows_only_ask_training_phrasings_nonsense_and_the_lane(rows):
    allowed = {p.text for p in phrasings() if p.split == "train"} | set(NONSENSE_TRAIN)
    for _, _, qid, q in _questions(rows):
        if qid == "lane":
            assert q == LANE_QUESTION
        else:
            assert q["type"] == "noul" and q["instructions"].startswith(RULE_PREFIX)
            assert q["instructions"][len(RULE_PREFIX):] in allowed


def test_no_benchmark_question_leaks(rows):
    banned = forbidden()
    for _, _, qid, q in _questions(rows):
        if qid != "lane":
            assert normalize(q["instructions"]) not in banned
            assert normalize(q["instructions"][len(RULE_PREFIX):]) not in banned


def test_held_out_topics_never_appear(rows):
    held = {k for k, t in TOPICS.items() if t.held_out}
    assert held
    for _, _, qid, _ in _questions(rows):
        assert qid.split(".")[0] not in held


def test_validation_states_are_disjoint_from_training(rows):
    train = {r["state"] for r in rows["train"]}
    val = {r["state"] for r in rows["val"]}
    assert val and not train & val


def test_labels_follow_the_story(rows):
    readings = {}
    for it in synth.items():
        s = summarize(it)
        readings[s["story"]] = reading_of(it, s)
    for _, row, qid, _ in _questions(rows):
        topic = qid.split(".")[0]
        p = row["gold"][qid]["probabilities"]
        if qid == "lane":
            assert set(p) == set(LANES) and abs(sum(p.values()) - 1) < 1e-9
            continue
        yes = p["true"] > p["false"]
        assert abs(p["true"] + p["false"] - 1) < 1e-9 and max(p.values()) == pytest.approx(0.95)
        if topic == "nonsense":
            assert not yes
        else:
            assert yes == truth(topic, readings[row["state"]])


def test_lane_rows_carry_the_fact_reading(rows):
    import eval as bench
    lanes = {}
    for it in synth.items():
        s = summarize(it)
        if not s["ruled"] and bench.reading(s) is not None:
            lanes[s["shape"]] = bench.reading(s)
    seen = [r for part in rows.values() for r in part if "lane" in r["questions"]]
    assert seen
    for r in seen:
        p = r["gold"]["lane"]["probabilities"]
        assert max(p, key=p.get) == lanes[r["state"]]


def test_nonsense_is_at_most_five_percent(rows):
    qids = [qid for _, _, qid, _ in _questions(rows) if qid != "lane"]
    nonsense = sum(q.startswith("nonsense.") for q in qids)
    assert 0 < nonsense <= 0.05 * (len(qids) - nonsense) + 1


def test_unreadable_transfers_only_get_amount_and_party_questions():
    facts_topics = {"swap", "bridge", "bridge_out", "bridge_in", "direct_payment", "signed", "defi", "vault",
                    "lending", "wrap", "cctp", "relay"}
    only = dataset.build([it for it, name in synth.labelled() if name == "unreadable"])
    unread = [r for part in only.values() for r in part if "could not be read" in r["state"]]
    assert unread
    for r in unread:
        for qid in r["questions"]:
            assert qid.split(".")[0] not in facts_topics, (qid, r["state"])


def test_the_benchmark_fixture_is_refused(tmp_path):
    from capture import FIXTURE
    with pytest.raises(SystemExit, match="benchmark"):
        dataset.main(["--capture", str(FIXTURE), "--out", str(tmp_path)])


def test_main_writes_the_trainer_format(tmp_path):
    capture = tmp_path / "cap.json"
    capture.write_text(json.dumps({"items": [], "txs": {}}))
    assert dataset.main(["--capture", str(capture), "--out", str(tmp_path / "out")]) == 0
    for name in ("train.jsonl", "val.jsonl", "stats.json", "audit.md"):
        assert (tmp_path / "out" / name).exists()
    first = json.loads((tmp_path / "out" / "train.jsonl").read_text().splitlines()[0])
    assert set(first) == {"state", "questions", "gold"} and set(first["gold"]) <= set(first["questions"])
    assert (tmp_path / "out" / "audit.md").read_text().count("\n- ") >= 60
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `.venv/bin/pytest -q tests/test_finetune_dataset.py`
Expected: `ImportError: cannot import name 'dataset' from 'finetune'`.

- [ ] **Step 3: Write `radar/finetune/dataset.py`**

```python
"""Rows for the fine-tune, from captured transfers and synthetic ones.

    .venv/bin/python -m finetune.dataset --capture "$DATA/train.json" --out "$DATA/rows"

Writes train.jsonl and val.jsonl in the trainer's {state, questions, gold}
format (laya docs/finetune.md), stats.json, and audit.md: sixty labelled
questions to read by hand before anything trains on them.

Three kinds of row, each asked the way the server asks it:
  * viewer questions over the story sentence, as rule_question() wraps them,
    labelled from the transfer's reading (questions.py);
  * the lane question over the shape sentence, verbatim, labelled with the
    fact table's lane -- only to keep the lanes where they are, at 99.8%;
  * a few nonsense questions, labelled "no", so the gate keeps refusing them.

Stories are templated -- 133 distinct ones in 1,200 live transfers -- so rows
are built per distinct story, not per transfer: a thousand copies of one swap
leg would teach the model that one sentence. Validation is one state in ten
by hash, so a sentence is never both trained on and used to choose the epoch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from capture import FIXTURE, load  # noqa: E402
from eval import reading as lane_of  # noqa: E402  -- the fact table's lane, with the lane descriptions' tie-break

from finetune import synth  # noqa: E402
from finetune.questions import NONSENSE_TRAIN, phrasings, reading_of, truth  # noqa: E402
from radar.classify import LANE_QUESTION, LANES, RULE_PREFIX, rule_question  # noqa: E402
from radar.summarize import summarize  # noqa: E402
from radar.types import Item  # noqa: E402

SMOOTH = 0.05          # targets 0.95/0.05, not 1/0: hard targets push the logits without bound
PER_ANSWER = 300       # distinct stories per topic per answer
PHRASINGS_EACH = 2     # training phrasings asked of each chosen story
LANE_REPEATS = 3       # lane rows are few; repeated in training so the questions do not out-vote them
NONSENSE_SHARE = 0.05  # of rule questions: enough to keep nonsense flat, not enough to teach "unfamiliar -> no"
VAL_ONE_IN = 10        # one state in ten, by hash, is validation
AUDIT_ROWS = 60


def is_val(state: str) -> bool:
    return int(hashlib.sha1(state.encode()).hexdigest()[:8], 16) % VAL_ONE_IN == 0


def noul_gold(yes: bool) -> dict[str, Any]:
    hi, lo = 1 - SMOOTH, SMOOTH
    return {"probabilities": {"true": hi if yes else lo, "false": lo if yes else hi}}


def lane_gold(lane: str) -> dict[str, Any]:
    rest = SMOOTH / (len(LANES) - 1)
    return {"probabilities": {k: (1 - SMOOTH if k == lane else rest) for k in LANES}}


def build(items: list[Item], seed: int = 0) -> dict[str, list[dict[str, Any]]]:
    rng = random.Random(seed)
    summaries = [summarize(i) for i in items]
    stories: dict[str, Any] = {}
    for it, s in zip(items, summaries):
        # One story reads one way (tests/test_finetune_questions.py), so the first transfer stands for all.
        stories.setdefault(s["story"], reading_of(it, s))
    texts: dict[str, list[str]] = {}
    for p in phrasings():
        if p.split == "train":
            texts.setdefault(p.topic, []).append(p.text)

    asked: dict[str, tuple[dict, dict]] = {}

    def ask(story: str, qid: str, text: str, yes: bool) -> None:
        questions, gold = asked.setdefault(story, ({}, {}))
        questions[qid] = rule_question(text)
        gold[qid] = noul_gold(yes)

    n_rules = 0
    for topic in sorted(texts):
        answers: dict[bool, list[str]] = {True: [], False: []}
        for story in sorted(stories):
            t = truth(topic, stories[story])
            if t is not None:
                answers[t].append(story)
        for yes in (True, False):
            group = answers[yes]
            rng.shuffle(group)
            for story in group[:PER_ANSWER]:
                for k, text in enumerate(rng.sample(texts[topic], min(PHRASINGS_EACH, len(texts[topic])))):
                    ask(story, f"{topic}.{k}", text, yes)
                    n_rules += 1
    pool = sorted(stories)
    for k in range(int(n_rules * NONSENSE_SHARE)):
        ask(rng.choice(pool), f"nonsense.{k}", rng.choice(NONSENSE_TRAIN), False)

    rows: dict[str, list[dict[str, Any]]] = {"train": [], "val": []}
    for story, (questions, gold) in sorted(asked.items()):
        rows["val" if is_val(story) else "train"].append({"state": story, "questions": questions, "gold": gold})

    shapes: dict[str, str] = {}
    for s in summaries:
        lane = None if s["ruled"] else lane_of(s)
        if lane is not None:
            shapes.setdefault(s["shape"], lane)
    for shape, lane in sorted(shapes.items()):
        split = "val" if is_val(shape) else "train"
        for _ in range(1 if split == "val" else LANE_REPEATS):
            rows[split].append({"state": shape, "questions": {"lane": LANE_QUESTION}, "gold": {"lane": lane_gold(lane)}})
    for part in rows.values():
        rng.shuffle(part)
    return rows


def stats(rows: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for split, part in rows.items():
        topics: Counter[str] = Counter()
        lanes: Counter[str] = Counter()
        for row in part:
            for qid, gold in row["gold"].items():
                p = gold["probabilities"]
                if qid == "lane":
                    lanes[max(p, key=p.get)] += 1
                else:
                    topics[f"{qid.split('.')[0]}:{'yes' if p['true'] > p['false'] else 'no'}"] += 1
        out[split] = {"rows": len(part), "questions": sum(topics.values()) + sum(lanes.values()),
                      "topics": dict(sorted(topics.items())), "lanes": dict(sorted(lanes.items()))}
    return out


def audit(rows: dict[str, list[dict[str, Any]]], seed: int) -> str:
    """Sixty labelled questions, to be read by hand: does the sentence say so?"""
    picked = []
    for row in rows["train"]:
        for qid, q in row["questions"].items():
            if qid != "lane":
                p = row["gold"][qid]["probabilities"]
                picked.append((row["state"], q["instructions"][len(RULE_PREFIX):], p["true"] > p["false"]))
    random.Random(seed).shuffle(picked)
    lines = ["# Label audit", "", "Read each: does the sentence alone back the answer?", ""]
    for state, question, yes in picked[:AUDIT_ROWS]:
        lines.append(f"- **{'yes' if yes else 'no'}** — {question}\n  > {state}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the fine-tune's rows.")
    parser.add_argument("--capture", type=Path, action="append", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    for path in args.capture:
        if path.resolve() == FIXTURE.resolve():
            raise SystemExit(f"{path} is eval.py's benchmark; it never becomes training data")
    items = [it for path in args.capture for it in load(path)] + synth.items()
    rows = build(items, args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    for split, part in rows.items():
        with open(args.out / f"{split}.jsonl", "w", encoding="utf-8") as f:
            for row in part:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    summary = stats(rows)
    (args.out / "stats.json").write_text(json.dumps(summary, indent=2))
    (args.out / "audit.md").write_text(audit(rows, args.seed))
    print(f"{len(items)} transfers -> train {summary['train']['questions']} questions in {summary['train']['rows']} rows, "
          f"val {summary['val']['questions']} in {summary['val']['rows']} ({args.out})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Add to the repository root `.gitignore`, after `.venv/`:

```
.venv-ft/
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `.venv/bin/pytest -q tests/test_finetune_dataset.py`
Expected: all pass.

- [ ] **Step 5: Run the whole radar suite**

Run: `.venv/bin/pytest -q`
Expected: all pass (the existing radar tests are untouched).

- [ ] **Step 6: Commit**

```bash
git add .gitignore radar/finetune/dataset.py radar/tests/test_finetune_dataset.py
git commit -m "feat(radar): fine-tune rows from captures and synthetic transfers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Trainer wrapper and its environment

**Files:**
- Create: `radar/finetune/trainlib.py`, `radar/finetune/train.py`, `radar/finetune/requirements-ft.in`, `radar/finetune/requirements-ft.txt` (compiled)
- Test: `radar/tests/test_finetune_trainlib.py`

**Interfaces:**
- Consumes: rows from Task 3 (`train.jsonl`, `val.jsonl`); laya PR #899 `laya.train` (`TrainConfig`, `load_checkpoint`, `items_from_rows`, `read_jsonl`, `train_model(..., on_epoch_end)`, `calibration_records`, `save_checkpoint`, `resolve_device`), `laya.calibrate.fit_temperature_map`, `laya.common.TEMP_MIN/TEMP_MAX`.
- Produces: `trainlib.clamp(obj, low, high)`, `trainlib.val_metrics(records) -> {"ce", "accuracy", "n"}`, `trainlib.improved(history, metrics) -> bool`, `trainlib.sha256_file(path) -> str`, `trainlib.Stop`; CLI `python -m finetune.train --data DIR --out DIR [--epochs 3] [--limit N] [--device mps]` writing `DIR/best/` (best epoch) and `DIR/final/` (calibrated checkpoint + `manifest.json`).

- [ ] **Step 1: Write the failing tests for the torch-free helpers**

Create `radar/tests/test_finetune_trainlib.py`:

```python
import math

from finetune.trainlib import clamp, improved, sha256_file, val_metrics


def test_clamp_reaches_nested_temperatures():
    fitted = {"temperature": {"choice": 0.2, "noul": 7.0, "score": 1.3}, "temperature_by_options": {"choice:8": 0.1}}
    assert clamp(fitted, 0.5, 5.0) == {"temperature": {"choice": 0.5, "noul": 5.0, "score": 1.3},
                                       "temperature_by_options": {"choice:8": 0.5}}


def test_val_metrics_scores_cross_entropy_and_accuracy():
    records = [("noul", [0.0, 2.0], [0.05, 0.95], 2), ("choice", [3.0, 0.0, 0.0], [0.0, 1.0, 0.0], 3)]
    m = val_metrics(records)
    assert m["n"] == 2 and m["accuracy"] == 0.5
    first = -(0.05 * math.log(1 / (1 + math.e ** 2)) + 0.95 * math.log(math.e ** 2 / (1 + math.e ** 2)))
    second = -math.log(1 / (math.e ** 3 + 2))
    assert math.isclose(m["ce"], (first + second) / 2, rel_tol=1e-9)


def test_only_a_lower_validation_loss_counts_as_better():
    assert improved([], {"ce": 0.5})
    assert improved([{"ce": 0.5}], {"ce": 0.4})
    assert not improved([{"ce": 0.5}, {"ce": 0.4}], {"ce": 0.45})


def test_sha256_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"abc")
    assert sha256_file(f) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/pytest -q tests/test_finetune_trainlib.py`
Expected: `ModuleNotFoundError: No module named 'finetune.trainlib'`.

- [ ] **Step 3: Write `radar/finetune/trainlib.py`**

```python
"""The parts of a training run that need no torch, so the radar's tests reach them."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any, Iterable


class Stop(Exception):
    """Raised from the epoch callback to end training early."""


def clamp(obj: Any, low: float, high: float) -> Any:
    """Every number in a fitted temperature map, held to [low, high].

    The MLX runtime clamps temperatures to [0.5, 5] when it loads them
    (laya-mlx agent.py), and laya's own scripts fit within [0.1, 10] (laya
    #851/#885). Storing the clamped value means what is measured in PyTorch is
    what MLX serves.
    """
    if isinstance(obj, dict):
        return {k: clamp(v, low, high) for k, v in obj.items()}
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        return min(high, max(low, float(obj)))
    return obj


def val_metrics(records: Iterable) -> dict[str, float]:
    """Soft cross-entropy and argmax accuracy of `calibration_records` output.

    Each record is (question type, logits, target, option count), options in
    canonical order. Cross-entropy is the selection metric: it is a proper
    score, so an epoch cannot win on it by being confidently wrong.
    """
    n = ce = right = 0
    for _qtype, logits, target, k in records:
        z = [float(v) for v in list(logits)[:k]]
        top = max(z)
        lse = top + math.log(sum(math.exp(v - top) for v in z))
        ce -= sum(float(t) * (v - lse) for t, v in zip(target, z))
        right += max(range(k), key=lambda i: z[i]) == max(range(k), key=lambda i: target[i])
        n += 1
    return {"ce": ce / max(n, 1), "accuracy": right / max(n, 1), "n": n}


def improved(history: list[dict[str, float]], metrics: dict[str, float]) -> bool:
    return not history or metrics["ce"] < min(h["ce"] for h in history)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()
```

- [ ] **Step 4: Run them to see them pass**

Run: `.venv/bin/pytest -q tests/test_finetune_trainlib.py`
Expected: 4 passed.

- [ ] **Step 5: Create the fine-tune environment**

Create `radar/finetune/requirements-ft.in`:

```
# The trainer environment (radar/.venv-ft). Never installed into the radar's own venv.
# laya PR #899 (laya.train), pinned to the commit that was read: GuilhermeFusari/laya@deb477dc.
laya @ git+https://github.com/GuilhermeFusari/laya@deb477dc85467c4198009271ebd7a5f07001131d
torch
safetensors
huggingface_hub
numpy
```

Run:

```bash
uv venv -q --python 3.12 .venv-ft
uv pip compile -q --python .venv-ft/bin/python finetune/requirements-ft.in -o finetune/requirements-ft.txt
uv pip install -q --python .venv-ft/bin/python -r finetune/requirements-ft.txt
.venv-ft/bin/python -c "import torch, laya.train; print(torch.__version__, torch.backends.mps.is_available())"
```

Expected: a torch version and `True`.

- [ ] **Step 6: Write `radar/finetune/train.py`**

```python
"""Fine-tune laya-multilingual for Arc Radar.

    .venv-ft/bin/python -m finetune.train --data "$DATA/rows" --out "$MODELS/laya-multilingual-arc-YYYYMMDD-N"

Runs in .venv-ft, never in the radar's own venv: the radar's runtime and its
Docker image stay torch-free. Start it under finetune.supervise, which pauses
it whenever the model the live radars share slows down.

What it does, and why each choice (the design record has the measurements):
  * full fine-tune with soft cross-entropy -- two independent tests found it
    at least as good as the RLCD objective (laya #741, PR #899);
  * the token-embedding table frozen -- 197M of the 322M weights, rows for
    100+ languages this data never touches, which AdamW's weight decay would
    otherwise shrink;
  * options never shuffled -- the lane order is part of the measured question;
  * the epoch kept is the one with the lowest validation cross-entropy, and
    training stops after one epoch without improvement;
  * temperatures fitted on validation and clamped to what MLX will serve.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import asdict
from pathlib import Path

os.environ.setdefault("USE_TF", "0")  # laya.load can deadlock when TensorFlow is importable (model card)

from finetune.trainlib import Stop, clamp, improved, sha256_file, val_metrics  # noqa: E402

BASE_REPO = "convaiinnovations/laya-multilingual"
BASE_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"
TRAINER = "laya PR #899 @ GuilhermeFusari/laya deb477dc85467c4198009271ebd7a5f07001131d"


def freeze_embeddings(model) -> int:
    """Hold the token-embedding table still; returns how many weights that is."""
    weight = model.encoder.get_input_embeddings().weight
    weight.requires_grad_(False)
    return weight.numel()


def main() -> int:
    from huggingface_hub import snapshot_download
    from laya.calibrate import fit_temperature_map
    from laya.common import TEMP_MAX, TEMP_MIN
    from laya.train import (TrainConfig, calibration_records, items_from_rows, load_checkpoint, read_jsonl,
                            resolve_device, save_checkpoint, train_model)

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data", type=Path, required=True, help="dataset directory (train.jsonl, val.jsonl)")
    parser.add_argument("--out", type=Path, required=True, help="run directory; best/ and final/ are written here")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--limit", type=int, default=0, help="first N rows of each split, for a smoke run")
    parser.add_argument("--device", default="mps")
    args = parser.parse_args()

    started = time.time()
    base = snapshot_download(BASE_REPO, revision=BASE_REVISION)
    model, tok, cfg = load_checkpoint(base)
    frozen = freeze_embeddings(model)
    # The checkpoint's own budgets (1024 / 256): batches pad to their longest
    # sequence, not to max_len, and the served config stays the base's.
    max_len, head_max_len = cfg.get("max_len", 1024), cfg.get("head_max_len", 256)
    rows = {split: read_jsonl(str(args.data / f"{split}.jsonl")) for split in ("train", "val")}
    if args.limit:
        rows = {split: part[:args.limit] for split, part in rows.items()}
    train_items, skipped = items_from_rows(tok, rows["train"], max_len, head_max_len)
    val_items, val_skipped = items_from_rows(tok, rows["val"], max_len, head_max_len)
    device = resolve_device(args.device)
    config = TrainConfig(epochs=args.epochs, micro_batch=8, grad_accum=4, encoder_lr=2e-5, head_lr=1e-4,
                         loss="soft-ce", shuffle_options=(), log_every=200)
    print(json.dumps({"train_items": len(train_items), "val_items": len(val_items), "skipped": skipped,
                      "val_skipped": val_skipped, "frozen_weights": frozen, "device": str(device)}), flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    history: list[dict] = []

    def on_epoch_end(epoch: int, loss: float) -> None:
        metrics = dict(val_metrics(calibration_records(model, tok, val_items, device, max_len, head_max_len)),
                       epoch=epoch + 1, train_loss=loss)
        model.train()  # calibration_records left it in eval mode, and training continues
        better = improved(history, metrics)
        history.append(metrics)
        print(json.dumps({"epoch": metrics, "kept": better}), flush=True)
        if not better:
            raise Stop
        save_checkpoint(model, tok, dict(cfg), str(args.out / "best"))

    try:
        train_model(model, tok, train_items, config, device, max_len, head_max_len, on_epoch_end=on_epoch_end)
    except Stop:
        print("stopped early: validation did not improve", flush=True)

    best, best_tok, best_cfg = load_checkpoint(str(args.out / "best"))
    best.to(device).eval()
    fitted = fit_temperature_map(calibration_records(best, best_tok, val_items, device, max_len, head_max_len))
    fitted = clamp({"temperature": fitted["temperature"],
                    "temperature_by_options": fitted["temperature_by_options"] or {}}, TEMP_MIN, TEMP_MAX)
    out_cfg = dict(best_cfg, fine_tuned=True, temperature=fitted["temperature"])
    out_cfg.pop("temperature_by_options", None)  # an inherited bucket map would mask the new fit at inference
    if fitted["temperature_by_options"]:
        out_cfg["temperature_by_options"] = fitted["temperature_by_options"]
    final = args.out / "final"
    save_checkpoint(best, best_tok, out_cfg, str(final))
    manifest = {
        "base": {"repo": BASE_REPO, "revision": BASE_REVISION},
        "trainer": TRAINER,
        "data": {split: {"sha256": sha256_file(args.data / f"{split}.jsonl"), "rows": len(rows[split])}
                 for split in ("train", "val")},
        "limit": args.limit,
        "items": {"train": len(train_items), "val": len(val_items), "skipped": skipped, "val_skipped": val_skipped},
        "frozen_weights": frozen,
        "config": asdict(config),
        "epochs": history,
        "kept_epoch": min(history, key=lambda h: h["ce"])["epoch"],
        "temperatures": fitted,
        "device": str(device),
        "seconds": round(time.time() - started),
    }
    (final / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"final": str(final), "kept_epoch": manifest["kept_epoch"], "seconds": manifest["seconds"]}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 7: Smoke-run the wrapper on CPU with a handful of rows**

This needs rows; build a throwaway set from the synthetic transfers only:

```bash
SMOKE="$(mktemp -d)"
echo '{"items": [], "txs": {}}' > "$SMOKE/empty.json"
.venv/bin/python -m finetune.dataset --capture "$SMOKE/empty.json" --out "$SMOKE/rows"
.venv-ft/bin/python -m finetune.train --data "$SMOKE/rows" --out "$SMOKE/run" --epochs 1 --limit 16 --device cpu
ls "$SMOKE/run/final" && python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m['kept_epoch'], m['temperatures'])" "$SMOKE/run/final/manifest.json"
```

Expected: `final/` holds `model.safetensors`, `rl_agent_config.json`, `encoder/`, `tokenizer/`, `manifest.json`; temperatures all within [0.5, 5]. A failure here in `freeze_embeddings` or in the laya API is fixed in `train.py` before going on.

- [ ] **Step 8: Commit**

```bash
git add radar/finetune/trainlib.py radar/finetune/train.py radar/finetune/requirements-ft.in radar/finetune/requirements-ft.txt radar/tests/test_finetune_trainlib.py
git commit -m "feat(radar): trainer wrapper -- frozen embeddings, early stop, clamped temperatures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Supervisor that shares the GPU politely

**Files:**
- Create: `radar/finetune/supervise.py`
- Test: `radar/tests/test_finetune_supervise.py`

**Interfaces:**
- Produces: `budget(baseline_p95: float) -> float`; `Pacer` with `step(p95: float | None, limit: float, now: float) -> str` (`"pause"`, `"resume"` or `""`); `supervise(cmd, *, read_p95, log, sleep, clock, spawn, signal_child) -> int`; CLI `python -m finetune.supervise [--health URL] [--log FILE] -- <command...>`.

- [ ] **Step 1: Write the failing tests**

Create `radar/tests/test_finetune_supervise.py`:

```python
import signal

import pytest

from finetune import supervise as sv


def test_budget_is_twice_the_baseline_with_a_floor():
    assert sv.budget(30.0) == sv.FLOOR_MS
    assert sv.budget(80.0) == 160.0


def test_pauses_at_once_and_resumes_only_after_calm():
    p = sv.Pacer()
    assert p.step(50.0, 120.0, 0.0) == ""
    assert p.step(300.0, 120.0, 5.0) == "pause"
    assert p.step(300.0, 120.0, 10.0) == ""
    assert p.step(60.0, 120.0, 15.0) == ""                       # calm starts
    assert p.step(60.0, 120.0, 15.0 + sv.RESUME_AFTER - 1) == ""
    assert p.step(60.0, 120.0, 15.0 + sv.RESUME_AFTER) == "resume"


def test_a_spike_while_paused_restarts_the_calm_clock():
    p = sv.Pacer()
    p.step(300.0, 120.0, 0.0)
    p.step(60.0, 120.0, 5.0)
    p.step(300.0, 120.0, 20.0)
    assert p.step(60.0, 120.0, 25.0) == ""
    assert p.step(60.0, 120.0, 25.0 + sv.RESUME_AFTER) == "resume"


def test_an_unreachable_model_counts_as_over_budget():
    p = sv.Pacer()
    assert p.step(None, 120.0, 0.0) == "pause"


class FakeChild:
    def __init__(self, polls_until_exit):
        self.pid = 4242
        self.left = polls_until_exit
        self.returncode = None
        self.terminated = False

    def poll(self):
        if self.left <= 0:
            self.returncode = 0
            return 0
        self.left -= 1
        return None

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def wait(self, timeout=None):
        return self.returncode


def _run(p95s, child, sleep=lambda s: None):
    sent = []
    readings = iter(p95s)
    t = [0.0]

    def clock():
        t[0] += sv.CHECK_EVERY
        return t[0]

    code = sv.supervise(["train"], read_p95=lambda: next(readings, 50.0), log=lambda line: None,
                        sleep=sleep, clock=clock, spawn=lambda cmd, **kw: child,
                        signal_child=lambda pid, sig: sent.append(sig), baseline_samples=2)
    return code, sent


def test_stops_and_continues_the_trainer_with_the_model_load():
    child = FakeChild(polls_until_exit=12)
    calm = [50.0] * (int(sv.RESUME_AFTER / sv.CHECK_EVERY) + 2)
    code, sent = _run([40.0, 40.0, 500.0, 500.0] + calm, child)
    assert code == 0
    assert sent == [signal.SIGSTOP, signal.SIGCONT]


def test_an_interrupted_supervisor_never_leaves_the_trainer_stopped():
    child = FakeChild(polls_until_exit=100)
    sent = []
    calls = {"n": 0}

    def sleep(_):
        calls["n"] += 1
        if calls["n"] == 5:
            raise KeyboardInterrupt

    readings = iter([40.0, 40.0, 500.0, 500.0, 500.0, 500.0])
    with pytest.raises(KeyboardInterrupt):
        sv.supervise(["train"], read_p95=lambda: next(readings, 500.0), log=lambda line: None, sleep=sleep,
                     clock=lambda: 0.0, spawn=lambda cmd, **kw: child,
                     signal_child=lambda pid, sig: sent.append(sig), baseline_samples=2)
    assert sent[0] == signal.SIGSTOP and sent[-1] == signal.SIGCONT
    assert child.terminated
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/pytest -q tests/test_finetune_supervise.py`
Expected: `ImportError: cannot import name 'supervise' from 'finetune'`.

- [ ] **Step 3: Write `radar/finetune/supervise.py`**

```python
"""Run the trainer without starving the radars that share this Mac's GPU.

    .venv/bin/python -m finetune.supervise --log "$RUN/train.log" -- \\
        .venv-ft/bin/python -m finetune.train --data "$DATA/rows" --out "$RUN"

Both radars ask the shared layad (127.0.0.1:8918) all day, and PyTorch on MPS
competes for the same GPU. There is no GPU priority to lower, so this pauses
the trainer instead: it reads the shared model's p95 latency (layad keeps it
over its last 512 requests) every few seconds, stops the trainer with SIGSTOP
the moment p95 is over budget, and continues it with SIGCONT once p95 has
stayed under budget for RESUME_AFTER seconds. The budget is twice the p95
measured before training starts, never under FLOOR_MS.

A model that does not answer counts as over budget: it is restarting, and a
cold model is the worst time to compete with it. On any exit the trainer is
continued before it is terminated, so a stopped process never outlives this
one holding GPU memory.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import statistics
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

HEALTH = "http://127.0.0.1:8918/health"
FLOOR_MS = 120.0
CHECK_EVERY = 5.0
RESUME_AFTER = 30.0
BASELINE_SAMPLES = 24      # two minutes at CHECK_EVERY


def budget(baseline_p95: float) -> float:
    return max(2 * baseline_p95, FLOOR_MS)


@dataclass
class Pacer:
    paused: bool = False
    calm_since: Optional[float] = None

    def step(self, p95: Optional[float], limit: float, now: float) -> str:
        if p95 is None or p95 > limit:
            self.calm_since = None
            if not self.paused:
                self.paused = True
                return "pause"
            return ""
        if not self.paused:
            return ""
        if self.calm_since is None:
            self.calm_since = now
            return ""
        if now - self.calm_since >= RESUME_AFTER:
            self.paused, self.calm_since = False, None
            return "resume"
        return ""


def p95_from(url: str) -> Callable[[], Optional[float]]:
    def read() -> Optional[float]:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return json.load(response)["latency_ms"]["p95"]
        except Exception:  # noqa: BLE001 - refused, timed out, restarting: all "not answering"
            return None
    return read


def supervise(cmd: list[str], *, read_p95: Callable[[], Optional[float]], log: Callable[[str], None],
              sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
              spawn=subprocess.Popen, signal_child: Callable[[int, int], None] = os.kill,
              baseline_samples: int = BASELINE_SAMPLES, stdout=None) -> int:
    samples = []
    for _ in range(baseline_samples):
        value = read_p95()
        if value is not None:
            samples.append(value)
        sleep(CHECK_EVERY)
    baseline = statistics.median(samples) if samples else FLOOR_MS / 2
    limit = budget(baseline)
    log(f"baseline p95 {baseline:.1f} ms; pausing above {limit:.1f} ms")

    child = spawn(cmd, stdout=stdout, stderr=subprocess.STDOUT)
    pacer, started, paused_at, paused_total = Pacer(), clock(), None, 0.0
    try:
        while child.poll() is None:
            now = clock()
            p95 = read_p95()
            action = pacer.step(p95, limit, now)
            if action == "pause":
                signal_child(child.pid, signal.SIGSTOP)
                paused_at = now
                log(f"paused: shared model p95 {p95} ms")
            elif action == "resume":
                signal_child(child.pid, signal.SIGCONT)
                paused_total += now - (paused_at if paused_at is not None else now)
                paused_at = None
                log(f"resumed after {paused_total:.0f} s paused in total")
            sleep(CHECK_EVERY)
    finally:
        if child.poll() is None:
            signal_child(child.pid, signal.SIGCONT)
            child.terminate()
            child.wait(timeout=30)
    elapsed = clock() - started
    if paused_at is not None:
        paused_total += clock() - paused_at
    log(f"trainer exited {child.returncode}; {elapsed:.0f} s, {paused_total:.0f} s paused")
    return child.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--health", default=HEALTH)
    parser.add_argument("--log", default="", help="the trainer's output goes here; supervision lines go to stdout")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    cmd = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not cmd:
        parser.error("give the trainer command after --")
    out = open(args.log, "a", buffering=1) if args.log else None

    def log(line: str) -> None:
        print(f"{time.strftime('%H:%M:%S')} {line}", flush=True)

    return supervise(cmd, read_p95=p95_from(args.health), log=log, stdout=out)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run them to see them pass**

Run: `.venv/bin/pytest -q tests/test_finetune_supervise.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add radar/finetune/supervise.py radar/tests/test_finetune_supervise.py
git commit -m "feat(radar): supervisor that pauses training while the shared model is slow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Report and parity

**Files:**
- Create: `radar/finetune/report.py`, `radar/finetune/parity.py`
- Test: `radar/tests/test_finetune_report.py`, `radar/tests/test_finetune_parity.py`

**Interfaces:**
- Consumes: `finetune.questions.phrasings/reading_of/truth`; `scripts/eval.py` `auc`, `CHUNK`, `MIN_COUNT`, `RULES_PER_CALL`; `radar.classify.Classifier`; `radar.gate.threshold`.
- Produces: `report.Score(auc, bal, pos, neg)`; `report.balanced(pos, neg, line) -> float`; `report.ask(endpoint, token, summaries, asked) -> (lines, answers)`; `report.tally(asked, readings, answers, lines, keep) -> dict[str, Score|None]`; `report.verdicts(base: dict[str, Score|None], ft: dict[str, Score|None], asked: list[Phrasing], stuck_ft: int) -> list[tuple[str, bool, str]]`; CLI `python -m finetune.report --base URL --ft URL --capture FILE [--token-env RADAR_TOKEN]` (exit 0 only if every verdict passes). `parity.compare(questions, ours, served) -> (lanes, agree, gap)`; CLI `python -m finetune.parity --model DIR --endpoint URL --rows FILE [--n 200]`.

- [ ] **Step 1: Write the failing tests**

Create `radar/tests/test_finetune_report.py`:

```python
from finetune.questions import Phrasing
from finetune.report import Score, balanced, verdicts


def test_balanced_accuracy_at_the_line():
    assert balanced([0.9, 0.8, 0.2], [0.1, 0.6], 0.5) == (2 / 3 + 1 / 2) / 2


def _s(bal):
    return Score(auc=bal, bal=bal, pos=20, neg=20)


ASKED = [
    Phrasing("swap", "a", "en", "heldout-phrasing"), Phrasing("swap", "b", "tr", "heldout-phrasing"),
    Phrasing("fee", "c", "en", "heldout-topic"), Phrasing("fee", "d", "tr", "heldout-topic"),
    Phrasing("swap", "e", "es", "heldout-language"),
]


def test_all_pass_when_phrasings_gain_and_nothing_else_drops():
    base = {"a": _s(0.70), "b": _s(0.70), "c": _s(0.80), "d": _s(0.70), "e": _s(0.70)}
    ft = {"a": _s(0.80), "b": _s(0.78), "c": _s(0.79), "d": _s(0.70), "e": _s(0.69)}
    assert all(ok for _, ok, _ in verdicts(base, ft, ASKED, stuck_ft=0))


def test_one_held_out_question_falling_more_than_five_points_fails():
    base = {"a": _s(0.70), "b": _s(0.70), "c": _s(0.80), "d": _s(0.70), "e": _s(0.70)}
    ft = {"a": _s(0.80), "b": _s(0.80), "c": _s(0.74), "d": _s(0.80), "e": _s(0.70)}
    failed = [name for name, ok, _ in verdicts(base, ft, ASKED, stuck_ft=0) if not ok]
    assert failed == ["no held-out topic question worse than base by more than 0.05"]


def test_uncountable_sets_and_stuck_rows_fail():
    base = {"a": None, "b": None, "c": _s(0.8), "d": _s(0.8), "e": _s(0.7)}
    ft = {"a": _s(0.9), "b": _s(0.9), "c": _s(0.8), "d": _s(0.8), "e": _s(0.7)}
    failed = {name for name, ok, _ in verdicts(base, ft, ASKED, stuck_ft=3) if not ok}
    assert "held-out phrasings gain at least 0.05" in failed
    assert "fine-tune leaves no row stuck on the test capture" in failed
```

Create `radar/tests/test_finetune_parity.py`:

```python
from finetune.parity import compare

QUESTIONS = {"lane": {"type": "choice"}, "q": {"type": "noul"}}


def test_compare_counts_lane_agreement_and_the_largest_gap():
    ours = {"lane": {"choice": "swap", "probabilities": {"swap": 0.90, "bridge": 0.10}}, "q": {"noul": 0.70}}
    served = {"lane": {"choice": "swap", "probabilities": {"swap": 0.88, "bridge": 0.12}}, "q": {"noul": 0.735}}
    lanes, agree, gap = compare(QUESTIONS, ours, served)
    assert (lanes, agree) == (1, 1) and abs(gap - 0.035) < 1e-9


def test_a_different_lane_is_a_disagreement():
    ours = {"lane": {"choice": "swap", "probabilities": {"swap": 0.51, "bridge": 0.49}}}
    served = {"lane": {"choice": "bridge", "probabilities": {"swap": 0.49, "bridge": 0.51}}}
    assert compare({"lane": {"type": "choice"}}, ours, served)[:2] == (1, 0)
```

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/pytest -q tests/test_finetune_report.py tests/test_finetune_parity.py`
Expected: import errors for `finetune.report` and `finetune.parity`.

- [ ] **Step 3: Write `radar/finetune/report.py`**

```python
"""Base vs fine-tune, on transfers and questions neither trained on.

    .venv/bin/python -m finetune.report --base http://127.0.0.1:8918 --ft http://127.0.0.1:8920 \\
        --capture "$DATA/test.json"

The capture is the test capture, taken after the training capture ended. Each
held-out phrasing is asked of every transfer the way the server asks it, read
at the line the gate measures for it, and scored like eval.py scores its
thirty: balanced accuracy and AUC over transfers whose story decides the
answer, counting a phrasing only when both models leave at least MIN_COUNT
yeses and noes. The verdicts are the design record's acceptance items 2-4,
plus no stuck rows; item 1 is eval.py on the fixture, run separately.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from capture import load  # noqa: E402
from eval import CHUNK, MIN_COUNT, RULES_PER_CALL, auc  # noqa: E402

from finetune.questions import Phrasing, phrasings, reading_of, truth  # noqa: E402
from radar.classify import Classifier  # noqa: E402
from radar.gate import threshold  # noqa: E402
from radar.summarize import summarize  # noqa: E402

PHRASING_GAIN = 0.05
TOPIC_SLACK = 0.02
QUESTION_SLACK = 0.05
LANGUAGE_SLACK = 0.03


@dataclass(frozen=True)
class Score:
    auc: float
    bal: float
    pos: int
    neg: int


def balanced(pos: list[float], neg: list[float], line: float) -> float:
    return (sum(p >= line for p in pos) / len(pos) + sum(n < line for n in neg) / len(neg)) / 2


async def ask(endpoint: str, token: str, summaries: list, asked: list[Phrasing]) -> tuple[dict, list]:
    """Each phrasing's yes line, and every transfer's answers, from one model."""
    c = Classifier(endpoint, token=token)
    lines = {p.text: threshold(await c.probe(p.text)) for p in asked}
    names = {f"q{k}": p for k, p in enumerate(asked)}
    keys = list(names)
    groups = [keys[k:k + RULES_PER_CALL] for k in range(0, len(keys), RULES_PER_CALL)]
    answers = [{"rules": {}, "stuck": False} for _ in items]
    for start in range(0, len(items), CHUNK):
        batch = summaries[start:start + CHUNK]
        for group in groups:
            got = await c.classify([s["shape"] for s in batch], [s["story"] for s in batch],
                                   {n: names[n].text for n in group})
            for a, g in zip(answers[start:start + CHUNK], got):
                a["rules"].update(g["rules"])
                a["stuck"] = a["stuck"] or g["stuck"]
    await c.close()
    return lines, [{"stuck": a["stuck"], "rules": {names[n].text: v for n, v in a["rules"].items()}} for a in answers]


def tally(asked: list[Phrasing], readings: list, answers: list, lines: dict, keep: list[bool]) -> dict:
    """Score per phrasing over the kept transfers whose story decides the answer."""
    out: dict[str, Optional[Score]] = {}
    for p in asked:
        pos, neg = [], []
        for r, a, k in zip(readings, answers, keep):
            t = truth(p.topic, r)
            if not k or t is None or a["stuck"] or p.text not in a["rules"]:
                continue
            (pos if t else neg).append(a["rules"][p.text])
        countable = len(pos) >= MIN_COUNT and len(neg) >= MIN_COUNT
        out[p.text] = Score(auc(pos, neg), balanced(pos, neg, lines[p.text]), len(pos), len(neg)) if countable else None
    return out


def _means(base: dict, ft: dict, texts: list[str]) -> tuple[Optional[float], Optional[float], list[str]]:
    both = [t for t in texts if base.get(t) and ft.get(t)]
    if not both:
        return None, None, []
    return statistics.mean(base[t].bal for t in both), statistics.mean(ft[t].bal for t in both), both


def verdicts(base: dict, ft: dict, asked: list[Phrasing], stuck_ft: int) -> list[tuple[str, bool, str]]:
    def texts(pred) -> list[str]:
        return [p.text for p in asked if pred(p)]

    out = []
    b, f, both = _means(base, ft, texts(lambda p: p.split == "heldout-phrasing"))
    out.append(("held-out phrasings gain at least 0.05", b is not None and f >= b + PHRASING_GAIN,
                f"base {b} -> ft {f} over {len(both)}"))
    b, f, both = _means(base, ft, texts(lambda p: p.split == "heldout-topic"))
    out.append(("held-out topics hold within 0.02", b is not None and f >= b - TOPIC_SLACK,
                f"base {b} -> ft {f} over {len(both)}"))
    worst = [t for t in both if ft[t].bal < base[t].bal - QUESTION_SLACK]
    out.append(("no held-out topic question worse than base by more than 0.05", not worst, ", ".join(worst)))
    b, f, both = _means(base, ft, texts(lambda p: p.split == "heldout-language"))
    out.append(("held-out languages hold within 0.03", b is not None and f >= b - LANGUAGE_SLACK,
                f"base {b} -> ft {f} over {len(both)}"))
    b, f, both = _means(base, ft, texts(lambda p: p.lang == "tr" and p.split != "train"))
    out.append(("Turkish holds within 0.03", b is not None and f >= b - LANGUAGE_SLACK,
                f"base {b} -> ft {f} over {len(both)}"))
    out.append(("fine-tune leaves no row stuck on the test capture", stuck_ft == 0, f"{stuck_ft} stuck"))
    return out


def _table(base: dict, ft: dict, asked: list[Phrasing]) -> str:
    rows = []
    for p in asked:
        b, f = base.get(p.text), ft.get(p.text)
        cells = (f"{b.bal:.2f}" if b else "  - ", f"{f.bal:.2f}" if f else "  - ",
                 f"{f.bal - b.bal:+.2f}" if b and f else "    ")
        rows.append(f"  {p.split:17s} {p.lang}  {p.text[:52]:52s} {cells[0]}  {cells[1]}  {cells[2]}")
    return "\n".join(rows)


async def run(args: argparse.Namespace) -> int:
    items = load(args.capture)
    summaries = [summarize(i) for i in items]
    readings = [reading_of(i, s) for i, s in zip(items, summaries)]
    asked = [p for p in phrasings() if p.split != "train"]
    token = os.environ.get(args.token_env, "")
    base_lines, base_answers = await ask(args.base, token, summaries, asked)
    ft_lines, ft_answers = await ask(args.ft, token, summaries, asked)
    every = [True] * len(items)
    base = tally(asked, readings, base_answers, base_lines, every)
    ft = tally(asked, readings, ft_answers, ft_lines, every)
    stuck_base = sum(a["stuck"] for a in base_answers)
    stuck_ft = sum(a["stuck"] for a in ft_answers)
    print(f"{len(items)} transfers; stuck rows base {stuck_base}, fine-tune {stuck_ft}")
    if args.rows:
        # Stories are templated, so most test transfers read like some training
        # row; the ones that do not show whether reading carried over to new sentences.
        seen = {json.loads(line)["state"] for name in ("train.jsonl", "val.jsonl")
                for line in (args.rows / name).read_text().splitlines()}
        unseen = [s["story"] not in seen for s in summaries]
        b, f, both = _means(tally(asked, readings, base_answers, base_lines, unseen),
                            tally(asked, readings, ft_answers, ft_lines, unseen),
                            [p.text for p in asked if p.split == "heldout-phrasing"])
        print(f"stories never trained on: {sum(unseen)} transfers; held-out phrasings base {b} -> ft {f} over {len(both)}")
    print(f"  {'split':17s} lang {'phrasing':52s} base  ft    delta")
    print(_table(base, ft, asked))
    results = verdicts(base, ft, asked, stuck_ft)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}  ({detail})")
    return 0 if all(ok for _, ok, _ in results) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--base", required=True)
    parser.add_argument("--ft", required=True)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--token-env", default="RADAR_TOKEN", help="env var holding the gate token, if any")
    parser.add_argument("--rows", type=Path, help="the dataset directory, to report stories never trained on")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Write `radar/finetune/parity.py`**

```python
"""Does the served MLX file answer as the trained PyTorch one did?

    .venv-ft/bin/python -m finetune.parity --model "$RUN/final" --endpoint http://127.0.0.1:8920 \\
        --rows "$DATA/rows/val.jsonl"

The trainer saves PyTorch weights; layad serves an fp16 MLX conversion of
them. Both read the same rl_agent_config.json, so they should agree: every
lane the same, and no probability further apart than MAX_GAP -- the bar
laya-mlx's own validation.json sets for fp16. Run in .venv-ft (torch); the
served side is asked over HTTP, exactly as the radar asks it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

MAX_GAP = 0.02


def compare(questions: dict, ours: dict, served: dict) -> tuple[int, int, float]:
    """(lane questions, lanes that agree, largest probability gap) for one state."""
    lanes = agree = 0
    gap = 0.0
    for qid, q in questions.items():
        a, b = ours[qid], served[qid]
        if q["type"] == "choice":
            lanes += 1
            agree += a["choice"] == b["choice"]
            gap = max(gap, max(abs(a["probabilities"][k] - b["probabilities"][k]) for k in a["probabilities"]))
        else:
            gap = max(gap, abs(a["noul"] - b["noul"]))
    return lanes, agree, gap


def _served(endpoint: str, state: str, questions: dict) -> dict:
    body = json.dumps({"states": [state], "questions": questions}).encode()
    request = urllib.request.Request(f"{endpoint.rstrip('/')}/ai/run/batch", data=body,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)["results"][0]["answers"]


def main() -> int:
    os.environ.setdefault("USE_TF", "0")
    import laya

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--rows", type=Path, required=True)
    parser.add_argument("--n", type=int, default=200)
    args = parser.parse_args()
    agent = laya.load(str(args.model), device="cpu")
    rows = [json.loads(line) for line in args.rows.read_text().splitlines()[:args.n]]
    lanes = agree = 0
    gap = 0.0
    for row in rows:
        ours = agent.predict(row["state"], row["questions"])["answers"]
        served = _served(args.endpoint, row["state"], row["questions"])
        n, a, g = compare(row["questions"], ours, served)
        lanes, agree, gap = lanes + n, agree + a, max(gap, g)
    ok = agree == lanes and gap < MAX_GAP
    print(f"{len(rows)} rows: lanes {agree}/{lanes} agree, largest gap {gap:.4f} -> {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `.venv/bin/pytest -q tests/test_finetune_report.py tests/test_finetune_parity.py`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add radar/finetune/report.py radar/finetune/parity.py radar/tests/test_finetune_report.py radar/tests/test_finetune_parity.py
git commit -m "feat(radar): acceptance report and MLX parity check for the fine-tune

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Arc's own model, gate and watchdog

**Files:**
- Modify: `radar/scripts/netwatch.py` (labels and repairs from env), `radar/scripts/com.arc-radar.model.plist`, `radar/scripts/install-netwatch.sh`, `radar/Dockerfile`, `radar/docker-compose.yml`, `radar/README.md`
- Create: `radar/scripts/com.arc-radar.netwatch-arc.plist`, `radar/scripts/install-arc-model.sh`
- Test: `radar/tests/test_netwatch.py`

**Interfaces:**
- Produces: `netwatch.agents(text: str) -> dict[str, list[str]]`; `netwatch.REPAIRS: set[str]`; env `NETWATCH_AGENTS`, `NETWATCH_REPAIRS`; `install-arc-model.sh <model-dir>`.

- [ ] **Step 1: Write the failing netwatch tests**

Append to `radar/tests/test_netwatch.py`:

```python
def test_agent_labels_can_come_from_the_environment():
    assert netwatch.agents("model=com.arc-radar.model, gate=com.arc-radar.gate,tunnel=com.stellar-radar.tunnel") == {
        "model": ["com.arc-radar.model"], "gate": ["com.arc-radar.gate"], "tunnel": ["com.stellar-radar.tunnel"]}
    assert netwatch.agents("") == {}


def test_only_allowed_layers_are_repaired(monkeypatch):
    monkeypatch.setattr(netwatch, "REPAIRS", {"model", "gate"})
    assert netwatch.repair("network", dry_run=True).startswith("network is down; left to")
    assert netwatch.repair("tunnel", dry_run=True).startswith("tunnel is down; left to")
```

(The file already imports the module as `netwatch`; check its first lines and match the name.)

- [ ] **Step 2: Run them to see them fail**

Run: `.venv/bin/pytest -q tests/test_netwatch.py`
Expected: `AttributeError: module 'netwatch' has no attribute 'agents'`.

- [ ] **Step 3: Change `radar/scripts/netwatch.py`**

Replace the `LABELS = {...}` block with:

```python
def agents(text: str) -> dict[str, list[str]]:
    """'model=a,gate=b' -> {'model': ['a'], 'gate': ['b']}; '' -> {}."""
    out: dict[str, list[str]] = {}
    for part in text.split(","):
        if "=" in part:
            layer, label = (s.strip() for s in part.split("=", 1))
            out.setdefault(layer, []).append(label)
    return out


# The agents on this Mac may carry either name: the ledger radar installed them
# first, and this repo's templates use its own. Whichever is loaded is the one.
# A second copy of this script watching Arc's own model sets its labels with
# NETWATCH_AGENTS instead (com.arc-radar.netwatch-arc.plist).
LABELS = agents(os.environ.get("NETWATCH_AGENTS", "")) or {
    "model": ["com.stellar-radar.model", "com.arc-radar.model"],
    "gate": ["com.stellar-radar.gate", "com.arc-radar.gate"],
    "tunnel": ["com.stellar-radar.tunnel", "com.arc-radar.tunnel"],
}
LAYERS = ["model", "gate", "network", "tunnel"]
# Which layers this copy may repair. The copy watching Arc's model repairs
# only its model and gate: the network and the tunnel are shared, and two
# watchdogs toggling the same Wi-Fi would undo each other.
REPAIRS = set(filter(None, os.environ.get("NETWATCH_REPAIRS", ",".join(LAYERS)).split(",")))
```

and make `repair` start with:

```python
def repair(layer: str, dry_run: bool) -> str:
    """Carry out one repair; returns what was done, for the log."""
    if layer not in REPAIRS:
        return f"{layer} is down; left to the watchdog that owns it"
```

(keep the rest of `repair` as it is; delete the old `LAYERS = [...]` line that followed `LABELS`, since it now sits in the new block).

- [ ] **Step 4: Run them to see them pass**

Run: `.venv/bin/pytest -q tests/test_netwatch.py`
Expected: all pass.

- [ ] **Step 5: Point the model agent at Arc's own checkpoint and port**

Replace `radar/scripts/com.arc-radar.model.plist` with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.arc-radar.model</string>
  <!-- Arc's own fine-tuned model, beside (not instead of) the shared one on
       8918. install-arc-model.sh writes the checkpoint path in place of
       __MODEL_DIR__. The MLX buffer cache is capped at 1 GiB: MLX never
       releases cached buffers on its own (17 GB once, unbounded), and this is
       the second model on the same 24 GB Mac. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>LAYAD_MODEL</key>
    <string>__MODEL_DIR__</string>
    <key>LAYAD_BATCH_SIZE</key>
    <string>256</string>
    <key>LAYAD_WARM</key>
    <string>1</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/gokbot/.local/share/uv/tools/layad/bin/python</string>
    <string>-c</string>
    <string>import mlx.core as mx, sys; mx.set_cache_limit(1*1024**3); sys.argv=['layad','serve','--host','127.0.0.1','--port','8920']; from layad.cli import main; sys.exit(main())</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/gokbot/Library/Logs/arc-radar-model.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/gokbot/Library/Logs/arc-radar-model.log</string>
</dict>
</plist>
```

(`com.arc-radar.gate.plist` stays as it is: the env file it sources sets `RADAR_GATE_PORT=8921` and `LAYAD_ENDPOINT=http://127.0.0.1:8920`.)

Create `radar/scripts/install-arc-model.sh` (and `chmod +x` it):

```bash
#!/usr/bin/env bash
# Serve Arc Radar's own model on this Mac: layad on 127.0.0.1:8920 with the
# fine-tuned checkpoint, and the authenticating gate on 127.0.0.1:8921 in
# front of it. The shared model and gate the Stellar radar uses (8918/8919)
# are left exactly as they are. Safe to run again: it refreshes the gate's
# copy of the radar and reloads both agents.
#
#   ./scripts/install-arc-model.sh "$HOME/Library/Application Support/arc-radar/finetune/models/<run>/final-mlx"
set -euo pipefail

MODEL="${1:?usage: install-arc-model.sh /abs/path/to/model-dir}"
[ -f "$MODEL/rl_agent_config.json" ] || { echo "no checkpoint at $MODEL" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/arc-radar"
ENV_FILE="$HOME/.config/arc-radar/env"
AGENTS="$HOME/Library/LaunchAgents"

# The gate runs from its own installed copy of the radar, so checking out
# another branch in the repo never changes what is serving.
mkdir -p "$APP"
uv venv -q --allow-existing --python 3.12 "$APP/.venv"
uv pip install -q --python "$APP/.venv/bin/python" --reinstall "$HERE/.."

# The same token the deployed radar already sends, taken from the shared
# gate's env file. Written once, owner-only, and never printed.
if [ ! -f "$ENV_FILE" ]; then
  token="$(grep -E '^RADAR_TOKEN=' "$HOME/.config/stellar-radar/env" | head -1 || true)"
  [ -n "$token" ] || { echo "no RADAR_TOKEN= line in ~/.config/stellar-radar/env" >&2; exit 1; }
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  printf '%s\nRADAR_GATE_PORT=8921\nLAYAD_ENDPOINT=http://127.0.0.1:8920\n' "$token" > "$ENV_FILE"
fi

sed -e "s#/Users/gokbot#$HOME#g" -e "s#__MODEL_DIR__#$MODEL#g" \
  "$HERE/com.arc-radar.model.plist" > "$AGENTS/com.arc-radar.model.plist"
sed "s#/Users/gokbot#$HOME#g" "$HERE/com.arc-radar.gate.plist" > "$AGENTS/com.arc-radar.gate.plist"
for label in com.arc-radar.model com.arc-radar.gate; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
done
echo "Arc model on 127.0.0.1:8920 ($MODEL); gate on 127.0.0.1:8921"
```

Create `radar/scripts/com.arc-radar.netwatch-arc.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.arc-radar.netwatch-arc</string>
  <!-- The same watchdog, watching Arc's own model through laya-arc.brages.uk.
       It may restart only Arc's model and gate; the network and the tunnel
       are shared and stay with com.arc-radar.netwatch. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>NETWATCH_TUNNEL_URL</key>
    <string>https://laya-arc.brages.uk/health</string>
    <key>NETWATCH_GATE_URL</key>
    <string>http://127.0.0.1:8921/health</string>
    <key>NETWATCH_MODEL_URL</key>
    <string>http://127.0.0.1:8920/health</string>
    <key>NETWATCH_STATE</key>
    <string>~/Library/Application Support/arc-radar/netwatch-arc.json</string>
    <key>NETWATCH_AGENTS</key>
    <string>model=com.arc-radar.model,gate=com.arc-radar.gate,tunnel=com.stellar-radar.tunnel</string>
    <key>NETWATCH_REPAIRS</key>
    <string>model,gate</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/gokbot/Library/Application Support/arc-radar/netwatch.py</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/Users/gokbot/Library/Logs/arc-radar-netwatch-arc.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/gokbot/Library/Logs/arc-radar-netwatch-arc.log</string>
</dict>
</plist>
```

In `radar/scripts/install-netwatch.sh`, replace everything after `cp "$HERE/netwatch.py" "$DEST/netwatch.py"` with:

```bash
# Two copies of the same script: one for the shared model the Stellar radar
# also uses, one for Arc's own (installed only once install-arc-model.sh has
# put Arc's model in place).
labels=(com.arc-radar.netwatch)
[ -f "$HOME/Library/LaunchAgents/com.arc-radar.model.plist" ] && labels+=(com.arc-radar.netwatch-arc)
for label in "${labels[@]}"; do
  sed "s#/Users/gokbot#$HOME#g" "$HERE/$label.plist" > "$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
done
echo "netwatch installed (${labels[*]}); it logs to ~/Library/Logs/arc-radar-netwatch*.log only when something is wrong"
```

and delete the now-unused `AGENT=` line at the top.

- [ ] **Step 6: Default endpoint and docs**

In `radar/Dockerfile` and `radar/docker-compose.yml`, change the default `LAYA_ENDPOINT` from `https://laya-gate.brages.uk` to `https://laya-arc.brages.uk`.

In `radar/README.md`:
- In "Running it", replace the paragraph that starts "The LaunchAgents in `scripts/`" with: Arc's model now runs as its own pair of agents (`com.arc-radar.model` on 8920 with the fine-tuned checkpoint, `com.arc-radar.gate` on 8921), installed by `scripts/install-arc-model.sh <model-dir>`, beside the shared model and gate on 8918/8919, which it never touches; published as `laya-arc.brages.uk` through the existing Cloudflare tunnel; watched by `com.arc-radar.netwatch-arc`.
- Add a section "Fine-tuning the model" listing, in order, the commands from Task 8 Steps 2–9 and the acceptance bars, and pointing to the design record.
- In the environment table, change `LAYA_ENDPOINT`'s deployed value to `https://laya-arc.brages.uk`.
- The accuracy figures are filled in by Task 8 Step 11.

- [ ] **Step 7: Run the whole suite and commit**

Run: `.venv/bin/pytest -q && bash -n scripts/install-arc-model.sh scripts/install-netwatch.sh && plutil -lint scripts/*.plist`
Expected: all pass; `OK` for every plist.

```bash
git add radar/scripts radar/tests/test_netwatch.py radar/Dockerfile radar/docker-compose.yml radar/README.md
git commit -m "feat(radar): Arc's own model, gate and watchdog beside the shared ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Run, measure, decide, ship

Operational. Nothing here is committed except the README numbers and the PR. Every step that touches a live service says so.

- [ ] **Step 1: Captures**

The training capture (`$DATA/train.json`, 15,000 transfers, `--every 4`) was started on 2026-10-04 before this plan. When it has finished (`$DATA/train-capture.log` ends with `wrote 15000 transfers`), start the test capture — never earlier:

```bash
.venv/bin/python scripts/capture.py 3000 --every 4 --out "$DATA/test.json" > "$DATA/test-capture.log" 2>&1
```

Expected: `wrote 3000 transfers in … transactions` (~32 min).

- [ ] **Step 2: Build the rows**

```bash
.venv/bin/python -m finetune.dataset --capture "$DATA/train.json" --out "$DATA/rows"
python3 -m json.tool "$DATA/rows/stats.json" | head -80
```

Expected: tens of thousands of training questions; every training topic has both yes and no rows (a topic with zero yes or zero no rows is a data gap to record in the manifest and README, not to paper over).

- [ ] **Step 3: Audit the labels by hand**

Read all 60 entries of `$DATA/rows/audit.md`. For each, does the sentence alone back the answer? Record the count of disagreements and any pattern in `$DATA/rows/audit-verdict.md`. Any systematic error stops the run: fix the truth in `questions.py` (with a test), rebuild, re-audit.

- [ ] **Step 4: Train under the supervisor**

```bash
RUN="$MODELS/laya-multilingual-arc-$(date +%Y%m%d)-1"; mkdir -p "$RUN"
PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.5 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.4 .venv/bin/python -m finetune.supervise --log "$RUN/train.log" -- \
  .venv-ft/bin/python -m finetune.train --data "$DATA/rows" --out "$RUN" --epochs 3 \
  > "$RUN/supervise.log" 2>&1
```

Run it in the background. Watch `$RUN/supervise.log` (pauses) and `$RUN/train.log` (losses). Expected end: `final/manifest.json` exists with `kept_epoch` and temperatures in [0.5, 5]. If paused time is over half of wall time after 30 minutes, stop it and rerun overnight.

- [ ] **Step 5: Convert to MLX fp16**

```bash
~/.local/share/uv/tools/layad/bin/python -m laya_mlx convert --model "$RUN/final" --dtype float16 --output "$RUN/final-mlx"
cp "$RUN/final/manifest.json" "$DATA/rows/audit-verdict.md" "$RUN/final-mlx/"
```

Expected: `{"output": ".../final-mlx", "dtype": "float16"}`.

- [ ] **Step 6: Serve it locally, outside launchd**

```bash
LAYAD_MODEL="$RUN/final-mlx" ~/.local/share/uv/tools/layad/bin/python -c "import mlx.core as mx, sys; mx.set_cache_limit(1*1024**3); sys.argv=['layad','serve','--host','127.0.0.1','--port','8920']; from layad.cli import main; sys.exit(main())" > "$RUN/serve.log" 2>&1
```

Run in the background; wait until `curl -s http://127.0.0.1:8920/health` shows `"loaded":true`.

- [ ] **Step 7: Parity**

```bash
.venv-ft/bin/python -m finetune.parity --model "$RUN/final" --endpoint http://127.0.0.1:8920 --rows "$DATA/rows/val.jsonl"
```

Expected: `PASS` (all lanes agree, gap < 0.02).

- [ ] **Step 8: Acceptance item 1 — the fixture**

```bash
LAYA_ENDPOINT=http://127.0.0.1:8918 .venv/bin/python scripts/eval.py > "$RUN/eval-base.txt"
LAYA_ENDPOINT=http://127.0.0.1:8920 .venv/bin/python scripts/eval.py > "$RUN/eval-ft.txt"
diff "$RUN/eval-base.txt" "$RUN/eval-ft.txt"
```

Check against the spec: lanes ≥ 99.5%; 30-question mean balanced accuracy ≥ base; no stuck rows (the question table covers `of 1200`); no answerable refused; nonsense turned away ≥ 8 of 14.

- [ ] **Step 9: Acceptance items 2–4 — the test capture**

```bash
.venv/bin/python -m finetune.report --base http://127.0.0.1:8918 --ft http://127.0.0.1:8920 --capture "$DATA/test.json" --rows "$DATA/rows" | tee "$RUN/report.txt"
```

Expected: every line `PASS`, exit 0.

- [ ] **Step 10: Decide**

If any of Steps 7–9 fails: stop the local layad (`kill` the Step 6 process), deploy nothing, write the numbers into `$RUN/final/manifest.json` (`"verdict": "rejected", "why": …`) and into the radar memory, and report. The next lever is data (more synthetic coverage, more phrasings), not hyperparameters.

If all pass, stop the Step 6 process and continue.

- [ ] **Step 11: Record the numbers**

Fill the README accuracy section with base → fine-tune from `eval-base.txt`/`eval-ft.txt` and `report.txt` (fixture lanes, 30-question means, held-out phrasing/topic/language/Turkish means, stuck rows), plus the run folder name. Commit:

```bash
git add radar/README.md
git commit -m "docs(radar): fine-tuned model's measured accuracy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 12: Install Arc's agents (live: adds services on this Mac)**

```bash
./scripts/install-arc-model.sh "$RUN/final-mlx"
sleep 90; curl -s http://127.0.0.1:8920/health | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8921/health   # 401 without the token = alive
curl -s http://127.0.0.1:8918/health | head -c 200; echo                  # the shared model, unchanged
```

- [ ] **Step 13: Publish through the tunnel (live: restarts the shared tunnel for a few seconds)**

Add to `~/.cloudflared/config.yml`, above `- service: http_status:404`:

```yaml
  - hostname: laya-arc.brages.uk
    service: http://127.0.0.1:8921
```

```bash
cloudflared tunnel route dns laya-gate laya-arc.brages.uk
launchctl kickstart -k "gui/$(id -u)/com.stellar-radar.tunnel"
sleep 15
curl -s -o /dev/null -w '%{http_code}\n' -A arc-radar/1.0 https://laya-arc.brages.uk/health   # 401
curl -s -o /dev/null -w '%{http_code}\n' -A arc-radar/1.0 https://laya-gate.brages.uk/health  # 401, Stellar's still up
./scripts/install-netwatch.sh
```

- [ ] **Step 14: Acceptance item 6 — through the public hostname**

```bash
set -a; . "$HOME/.config/arc-radar/env"; set +a
LAYA_ENDPOINT=https://laya-arc.brages.uk .venv/bin/python scripts/eval.py | tee "$RUN/eval-public.txt"
```

Expected: the same lane and question figures as `eval-ft.txt`.

- [ ] **Step 15: Switch the deployed radar (live)**

In Dokploy (project Arckive → service `radar` → Environment) set `LAYA_ENDPOINT=https://laya-arc.brages.uk` and redeploy. If this session cannot reach Dokploy, hand the one-line change to the user. Then watch https://radar.arckive.org for ten minutes: lanes populated, a viewer question answered, no "offline" banner. Rollback is the same field back to `https://laya-gate.brages.uk`.

- [ ] **Step 16: PR, memory**

Push `feat/radar-finetune`, open a PR to `main` with the acceptance tables, merge it once CI passes. Update the Arc Radar memory with the run folder, the numbers, the new ports/hostname, and the rollback.
