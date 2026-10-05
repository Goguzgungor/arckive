"""The radar's question benchmark, widened to sixty-six English questions.

    .venv/bin/python -m finetune.bench --capture "$DATA/bench.json" \\
        --base http://127.0.0.1:8918 --ft http://127.0.0.1:8920 --out "$DATA/bench-results.json"

eval.py's thirty questions on its 1,200-transfer fixture leave only seventeen
English ones countable: rare topics -- CCTP, vaults, marketplaces, KyberSwap --
never reach ten yeses in 1,200 transfers. This keeps eval.py's twenty-seven
English questions with their own truths, adds thirty-nine new ones, and runs
them on a fresh capture large enough for rare topics to count.

The new questions were written on 2026-10-04 after the fine-tune was trained
and chosen, and committed before either model answered them, so none of them
could have been picked for how it scores. None repeats a trained, replayed or
held-out wording (tests hold that). Each says whether its concept was taught:
a taught concept in new words tests whether training generalised past the
bank's phrasings; an untaught one tests what the fine-tune kept.

Truths come from the transfer's reading (questions.py) and are None where the
sentence cannot decide; those transfers are not scored for that question.
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
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import eval as bench_eval  # noqa: E402
from capture import FIXTURE, load  # noqa: E402

from finetune.questions import Phrasing, reading_of, truth  # noqa: E402
from finetune.report import Score, ask, balanced  # noqa: E402
from radar.summarize import summarize  # noqa: E402

MIN_COUNT = bench_eval.MIN_COUNT


@dataclass(frozen=True)
class Question:
    text: str
    truth: Callable  # (item, summary) -> bool | None
    origin: str      # "eval" (eval.py's own) or "new" (written for this benchmark)
    taught: bool     # whether the fine-tune was trained on this concept


def _t(*topics: str, amount: Optional[Callable[[float], bool]] = None) -> Callable:
    """All of these topics true (and the amount test, if any); None if any is undecided."""
    def decide(it, s) -> Optional[bool]:
        r = reading_of(it, s)
        out = True
        for topic in topics:
            v = truth(topic, r)
            if v is None:
                return None
            out = out and v
        if amount is not None:
            out = out and amount(r.amount)
        return out
    return decide


def _party(side: str, kind: str, *topics: str) -> Callable:
    base = _t(*topics) if topics else (lambda it, s: True)

    def decide(it, s) -> Optional[bool]:
        r = reading_of(it, s)
        seen = getattr(r, side)
        if seen == "account":
            return None
        b = base(it, s)
        return None if b is None else (b and seen == kind)
    return decide


_TAUGHT_EVAL = {
    "Is this a swap?", "Is this a bridge transfer?", "Is USDC leaving Arc through a bridge?",
    "Did these funds arrive from another chain?", "Is this transfer over 10,000 USDC?", "Is this more than 100 USDC?",
    "Is this less than one dollar?", "Is this a direct payment between two wallets?", "Did a wallet receive the USDC?",
    "Did the USDC go into a contract?", "Was USDC minted?", "Is this a gasless signed payment?",
    "Did this go through CCTP?", "Is this a large swap?", "Is this a DeFi transaction?",
    "Is this a vault deposit or withdrawal?",
}

EVAL = [Question(q, t, "eval", q in _TAUGHT_EVAL) for q, t in bench_eval.QUESTIONS if q.isascii()]

NEW = [
    # taught concepts, new words
    Question("Was a token swap part of this transaction?", _t("swap"), "new", True),
    Question("Did this transfer happen inside a swap?", _t("swap"), "new", True),
    Question("Did money cross from Arc to another network?", _t("bridge_out"), "new", True),
    Question("Was this USDC brought over from a different network?", _t("bridge_in"), "new", True),
    Question("Did this move through a cross-chain bridge?", _t("bridge"), "new", True),
    Question("Is the amount ten thousand USDC or more?", _t("over_10k"), "new", True),
    Question("Is this a transfer of a hundred USDC or more?", _t("over_100"), "new", True),
    Question("Is the value below one USDC?", _t("under_1"), "new", True),
    Question("Is this smaller than a cent?", _t("under_cent"), "new", True),
    Question("Did zero USDC change hands?", _t("zero_amount"), "new", True),
    Question("Was a contract on the receiving end?", _t("to_contract"), "new", True),
    Question("Did a regular wallet get these funds?", _t("to_wallet"), "new", True),
    Question("Did a contract send these funds?", _t("from_contract"), "new", True),
    Question("Was this a simple payment between two wallets with nothing else going on?", _t("direct_payment"), "new", True),
    Question("Was this paid by signed authorization rather than by the sender's own transaction?", _t("signed"), "new", True),
    Question("Was this part of decentralized finance?", _t("defi"), "new", True),
    Question("Was Circle's cross-chain protocol used?", _t("cctp"), "new", True),
    Question("Did the Relay bridge carry this?", _t("relay"), "new", True),
    Question("Was USDC created in this transaction?", _t("minted"), "new", True),
    Question("Did wrapping or unwrapping of USDC happen here?", _t("wrap"), "new", True),
    Question("Did a vault take in or pay out these funds?", _t("vault"), "new", True),
    # taught concepts combined in ways no training row asked
    Question("Was more than 100 USDC bridged out of Arc?", _t("bridge_out", amount=lambda a: a >= 100), "new", True),
    Question("Did a wallet send USDC into a swap?", _party("frm", "wallet", "swap"), "new", True),
    Question("Was less than a dollar moved in a swap?", _t("swap", amount=lambda a: a < 1), "new", True),
    Question("Did a contract pay a wallet as part of a swap?", _party("to", "wallet", "swap", "from_contract"), "new", True),
    Question("Is this a big swap over 10,000 USDC?", _t("swap", amount=lambda a: a >= 10_000), "new", True),
    # untaught concepts
    Question("Did someone pay a fee in this transaction?", _t("fee"), "new", False),
    Question("Was the sender a smart contract account like ERC-4337?", _t("smart_account"), "new", False),
    Question("Did a liquidity pool change size?", _t("liquidity"), "new", False),
    Question("Did one transaction pay out to a lot of recipients?", _t("batch"), "new", False),
    Question("Were rewards handed out or claimed?", _t("payout"), "new", False),
    Question("Was this an NFT or marketplace purchase?", _t("market"), "new", False),
    Question("Is this junk with no real value?", _t("spam"), "new", False),
    Question("Was this swap done on Uniswap?", _t("uniswap"), "new", False),
    Question("Was this routed by OKX's DEX router?", _t("okx"), "new", False),
    Question("Did KyberSwap route this trade?", _t("kyberswap"), "new", False),
    Question("Was this bridged using LI.FI?", _t("lifi"), "new", False),
    Question("Was the trade on Aerodrome?", _t("aerodrome"), "new", False),
    Question("Was a fee taken on a swap?", _t("fee", "swap"), "new", False),
]

QUESTIONS = EVAL + NEW


def score(questions: list[Question], items: list, summaries: list, lines: dict, answers: list) -> dict:
    out = {}
    for q in questions:
        pos, neg = [], []
        for it, s, a in zip(items, summaries, answers):
            t = q.truth(it, s)
            if t is None or a["stuck"] or q.text not in a["rules"]:
                continue
            (pos if t else neg).append(a["rules"][q.text])
        ok = len(pos) >= MIN_COUNT and len(neg) >= MIN_COUNT
        out[q.text] = Score(bench_eval.auc(pos, neg), balanced(pos, neg, lines[q.text]), len(pos), len(neg)) if ok else None
    return out


def summary(base: dict, ft: dict, questions: list[Question]) -> dict:
    def mean(pick) -> dict:
        both = [q.text for q in questions if pick(q) and base.get(q.text) and ft.get(q.text)]
        if not both:
            return {"n": 0}
        return {"n": len(both),
                "base_bal": round(statistics.mean(base[t].bal for t in both), 3),
                "ft_bal": round(statistics.mean(ft[t].bal for t in both), 3),
                "base_auc": round(statistics.mean(base[t].auc for t in both), 3),
                "ft_auc": round(statistics.mean(ft[t].auc for t in both), 3)}
    return {"all": mean(lambda q: True), "eval": mean(lambda q: q.origin == "eval"), "new": mean(lambda q: q.origin == "new"),
            "taught": mean(lambda q: q.taught), "untaught": mean(lambda q: not q.taught)}


async def run(args: argparse.Namespace) -> int:
    if args.capture.resolve() == FIXTURE.resolve():
        print("note: scoring eval.py's own fixture", file=sys.stderr)
    items = load(args.capture)
    summaries = [summarize(i) for i in items]
    asked = [Phrasing("bench", q.text, "en", "bench") for q in QUESTIONS]
    token = os.environ.get(args.token_env, "")
    result = {"capture": str(args.capture), "transfers": len(items), "questions": []}
    scores = {}
    for name, url in (("base", args.base), ("ft", args.ft)):
        lines, answers = await ask(url, token, summaries, asked)
        scores[name] = score(QUESTIONS, items, summaries, lines, answers)
        result[f"stuck_{name}"] = sum(a["stuck"] for a in answers)
    for q in QUESTIONS:
        b, f = scores["base"][q.text], scores["ft"][q.text]
        result["questions"].append({"q": q.text, "origin": q.origin, "taught": q.taught,
                                    "base": b and b.__dict__, "ft": f and f.__dict__})
    result["summary"] = summary(scores["base"], scores["ft"], QUESTIONS)
    args.out.write_text(json.dumps(result, indent=1))
    s = result["summary"]
    print(f"{len(items)} transfers; countable {s['all']['n']} of {len(QUESTIONS)} questions")
    for k in ("all", "eval", "new", "taught", "untaught"):
        v = s[k]
        if v["n"]:
            print(f"  {k:9s} n={v['n']:2d}  balanced {v['base_bal']:.3f} -> {v['ft_bal']:.3f}   AUC {v['base_auc']:.3f} -> {v['ft_auc']:.3f}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--ft", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--token-env", default="RADAR_TOKEN")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
