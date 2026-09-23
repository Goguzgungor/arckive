"""How right the radar is, on captured live transfers.

    .venv/bin/python scripts/eval.py                  # the fixture; needs layad on LAYA_ENDPOINT
    .venv/bin/python scripts/eval.py /tmp/big.json    # a bigger capture (scripts/capture.py --out)

Three measurements, each against a reading of the transfer that does not
come from the model:

  lanes      The lane the model picks, against the lane the evidence gives.
             "The evidence" is the fact table read with the tie-break the
             lane descriptions state (a swap that ends in a bridge is a
             bridge), and it was itself audited: on ten minutes of mainnet
             each of its readings was checked against what the transaction
             actually moved -- who gave what, who got what back -- and read
             by hand where the two disagreed. Transfers the evidence cannot
             place (nothing recognisable, or only "a smart account sent it")
             are not scored. Bar: 95%.
  questions  Twenty-four questions viewers ask, each with its answer
             computed from the transfer, asked the way the server asks them
             and read at the line the gate measures for each. Reported as
             AUC (does it rank yeses above noes) and balanced accuracy (does
             the highlighted set match). Bar: 0.75 balanced accuracy.
  gate       Every question above must clear MIN_SEPARATION: turning away a
             question the radar can answer is the costlier mistake. How much
             polished nonsense it still turns away is reported, not required
             (see gate.MIN_SEPARATION for why it cannot be).

layad's GPU is shared with another live radar, so every call here is as small
as the server's own.
"""
from __future__ import annotations

import asyncio
import os
import statistics
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from capture import FIXTURE, load  # noqa: E402
from radar.classify import Classifier  # noqa: E402
from radar.gate import MIN_SEPARATION, separation, threshold  # noqa: E402
from radar.server import UNCERTAIN_BELOW, settle_lane  # noqa: E402
from radar.signatures import bridge_direction, venue_of  # noqa: E402
from radar.summarize import summarize  # noqa: E402
from radar.types import ZERO  # noqa: E402

LANE_BAR = 0.95
QUESTION_BAR = 0.75
CHUNK = 16          # transfers per model call, like a server batch at its busiest
RULES_PER_CALL = 8  # MAX_RULES in server.py

# The evidence, read with the lane descriptions' own tie-break.
PRECEDENCE = [("bridge", "bridge"), ("liquidity", "liquidity"), ("lending", "lending"), ("vault", "vault"),
              ("swap", "swap"), ("market", "swap"), ("batch", "payment"), ("payout", "payment"),
              ("wrap", "vault"), ("signed", "signed_payment")]


def reading(s: dict[str, Any]) -> str | None:
    for fact, lane in PRECEDENCE:
        if fact in s["facts"]:
            return lane
    if s["shape"].endswith("it was a plain direct transfer."):
        return "payment"
    return None


def _amount(it: dict[str, Any]) -> float:
    return it["transfer"]["value"] / 1e6


def _wallet(it: dict[str, Any], a: str) -> bool:
    return it["contracts"].get(a) is False


Truth = Callable[[dict[str, Any], dict[str, Any]], bool]
QUESTIONS: list[tuple[str, Truth]] = [
    ("Is this a swap?", lambda it, s: bool({"swap", "market"} & set(s["facts"]))),
    ("Is this a bridge transfer?", lambda it, s: "bridge" in s["facts"]),
    ("Is USDC leaving Arc through a bridge?", lambda it, s: "bridge" in s["facts"] and bridge_direction(it["ctx"]) == "out"),
    ("Did these funds arrive from another chain?", lambda it, s: "bridge" in s["facts"] and bridge_direction(it["ctx"]) == "in"),
    ("Is this transfer over 10,000 USDC?", lambda it, s: _amount(it) >= 10_000),
    ("Is this more than 100 USDC?", lambda it, s: _amount(it) >= 100),
    ("Is this less than one dollar?", lambda it, s: _amount(it) < 1),
    ("Was it sent by a smart account?", lambda it, s: "smart_account" in s["facts"]),
    ("Was a fee taken?", lambda it, s: "fee" in s["facts"]),
    ("Is this a direct payment between two wallets?", lambda it, s: s["shape"].endswith("it was a plain direct transfer.")
        and _wallet(it, it["transfer"]["frm"]) and _wallet(it, it["transfer"]["to"])),
    ("Did a wallet receive the USDC?", lambda it, s: _wallet(it, it["transfer"]["to"])),
    ("Did the USDC go into a contract?", lambda it, s: it["contracts"].get(it["transfer"]["to"]) is True),
    ("Is this spam or dust?", lambda it, s: _amount(it) < 0.01 and not s["facts"]),
    ("Is liquidity being added or removed?", lambda it, s: "liquidity" in s["facts"]),
    ("Was USDC minted?", lambda it, s: it["transfer"]["frm"] == ZERO),
    ("Is this a gasless signed payment?", lambda it, s: "signed" in s["facts"]),
    ("Is this a Uniswap trade?", lambda it, s: "swap" in s["facts"] and bool(it["ctx"]) and venue_of(it["ctx"]) == "Uniswap"),
    ("Did this go through CCTP?", lambda it, s: s["protocol"] == "CCTP"),
    ("Is this a large swap?", lambda it, s: "swap" in s["facts"] and _amount(it) >= 10_000),
    ("Is this a DeFi transaction?", lambda it, s: bool(set(s["facts"]) & {"swap", "liquidity", "vault", "lending",
                                                                            "bridge", "market", "wrap"})),
    ("Is this a batch payout to many wallets?", lambda it, s: "batch" in s["facts"]),
    ("Bu bir swap mı?", lambda it, s: bool({"swap", "market"} & set(s["facts"]))),
    ("Bu işlem köprü üzerinden mi geçti?", lambda it, s: "bridge" in s["facts"]),
    ("10.000 USDC'den büyük mü?", lambda it, s: _amount(it) >= 10_000),
]

# Grammatical, pass every wording check, and mean nothing about a transfer.
NONSENSE = [
    "is the sender a purple elephant?", "does this transfer taste like chocolate?", "is the moon made of cheese?",
    "did a dragon approve this?", "is the recipient happy today?", "does the wallet own a cat?",
    "is this transfer wearing a hat?", "did Shakespeare write this?", "is the ocean blue today?",
    "does this payment like jazz music?",
]


def auc(pos: list[float], neg: list[float]) -> float:
    ranked = sorted([(p, 1) for p in pos] + [(n, 0) for n in neg])
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        rank_sum += sum(1 for k in range(i, j) if ranked[k][1]) * (i + j + 1) / 2
        i = j
    return (rank_sum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


async def main(path: Path) -> int:
    items = load(path)
    summaries = [summarize(i) for i in items]
    c = Classifier(os.environ.get("LAYA_ENDPOINT", "http://127.0.0.1:8918"), token=os.environ.get("RADAR_TOKEN", ""))

    # ---- the gate: which questions are let through, and where each says yes
    lines: dict[str, float] = {}
    real, nonsense = [], []
    for question, _ in QUESTIONS:
        scores = await c.probe(question)
        lines[question] = threshold(scores)
        real.append((separation(scores), question))
    for question in NONSENSE:
        nonsense.append((separation(await c.probe(question)), question))

    # ---- lanes and questions, a server-sized batch at a time
    rules = {f"q{k}": q for k, (q, _) in enumerate(QUESTIONS)}
    groups = [dict(list(rules.items())[k:k + RULES_PER_CALL]) for k in range(0, len(rules), RULES_PER_CALL)]
    answers: list[dict[str, Any]] = []
    for start in range(0, len(items), CHUNK):
        batch = summaries[start:start + CHUNK]
        merged = [dict(a, rules={}) for a in await c.classify([s["shape"] for s in batch])]
        for group in groups:
            got = await c.classify([s["shape"] for s in batch], [s["story"] for s in batch], group)
            for m, g in zip(merged, got):
                m["rules"].update(g["rules"])
                m["stuck"] = m.get("stuck") or g["stuck"]
        answers.extend(merged)
    await c.close()

    ruled = Counter(s["ruled"] for s in summaries if s["ruled"])
    scored = right = uncertain = 0
    wrong: Counter[tuple[str, str]] = Counter()
    confidence = []
    for s, a in zip(summaries, answers):
        want = reading(s)
        if s["ruled"] or want is None:
            continue
        lane, p = settle_lane(a)
        scored += 1
        confidence.append(a.get("probabilities", {}).get(want, 0.0))
        if lane == want:
            right += 1
        elif lane == "uncertain":
            uncertain += 1
        else:
            wrong[(want, lane)] += 1
    lane_rate = right / scored if scored else 0.0

    print(f"{len(items)} transfers, {len(set(s['shape'] for s in summaries))} distinct lane sentences, "
          f"{len(set(s['story'] for s in summaries))} distinct stories")
    print(f"decided by the transfer itself: {dict(ruled)}")
    print(f"lanes: {right}/{scored} = {lane_rate:.1%} agree, {uncertain / max(scored, 1):.1%} below "
          f"{UNCERTAIN_BELOW}, right lane at {statistics.mean(confidence):.2f} on average")
    for (want, got), n in wrong.most_common(6):
        print(f"  {n:5d}  expected {want:15s} got {got}")

    aucs, bals = [], []
    print("questions (AUC / balanced accuracy at the gate's line):")
    for k, (question, truth) in enumerate(QUESTIONS):
        pos, neg = [], []
        for it, s, a in zip(items, summaries, answers):
            if a["stuck"] or f"q{k}" not in a["rules"]:
                continue
            (pos if truth(it, s) else neg).append(a["rules"][f"q{k}"])
        if not pos or not neg:
            print(f"  {question[:46]:46s}  no {'yes' if not pos else 'no'} in this sample")
            continue
        line = lines[question]
        bal = (sum(p >= line for p in pos) / len(pos) + sum(n < line for n in neg) / len(neg)) / 2
        aucs.append(auc(pos, neg))
        bals.append(bal)
        print(f"  {question[:46]:46s}  {aucs[-1]:.2f} / {bal:.2f}   (yes from {line:.2f}, {len(pos)} of {len(pos) + len(neg)})")
    question_rate = statistics.mean(bals)
    print(f"questions: mean AUC {statistics.mean(aucs):.3f}, mean balanced accuracy {question_rate:.3f}")

    weakest_real = min(real)
    refused = [q for v, q in real if v < MIN_SEPARATION]
    stopped = sum(1 for v, _ in nonsense if v < MIN_SEPARATION)
    gate_ok = not refused
    print(f"gate: weakest real question separates by {weakest_real[0]:.2f} ({weakest_real[1]!r}); "
          f"{'none' if gate_ok else refused} refused at MIN_SEPARATION {MIN_SEPARATION}; "
          f"{stopped} of {len(nonsense)} nonsense questions turned away")

    return 0 if lane_rate >= LANE_BAR and question_rate >= QUESTION_BAR and gate_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(Path(sys.argv[1]) if len(sys.argv) > 1 else FIXTURE)))
