"""Questions the fine-tune is not taught, kept the way the base model answers them.

    .venv/bin/python -m finetune.replay --capture "$DATA/train.json" --out "$DATA/replay.json"

Two runs on 2026-10-04 showed what fine-tuning on the question bank does to
everything outside it. Taught topics went sharp (fixture balanced accuracy
0.824 -> 0.990), but questions in words it was not taught -- "is this spam or
dust?", "was a commission paid?", Turkish "ödül" -- were answered near 0.05 on
every transfer. The ranking mostly survived; the spread did not, and the gate,
which measures the spread, refused them as flat. Dropping the nonsense rows
(run 2) did not help, so it is the fine-tune itself.

The remedy is learning without forgetting: alongside the labelled rows, ask
each story a few questions from outside the bank and train toward the answers
the base model gave, so the model keeps reading unfamiliar questions as it did
before while it learns the taught ones.

These questions avoid every concept the bank teaches (their labels would
fight the base's weaker answers), every held-out topic (those must stay
unseen in any form, or the report's held-out figures mean nothing), and every
concept eval.py asks about (training toward its answers would be gaming it).
AVOID holds those words; a test keeps the questions clear of them.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from capture import FIXTURE, load  # noqa: E402

from finetune import synth  # noqa: E402
from radar.classify import RULE_PREFIX  # noqa: E402
from radar.summarize import summarize  # noqa: E402

EACH = 6     # replay questions per story: ~25% of the rows, beside the bank's
CHUNK = 16   # stories per call, as small as the server's own: the base runs on the shared GPU

QUESTIONS = (
    "Is this an airdrop?", "Was this a refund?", "Is this an international remittance?", "Was this a donation?",
    "Is this a subscription payment?", "Is this a recurring payment?", "Did a DAO treasury send this?",
    "Is this an escrow release?", "Was this paid to a merchant?", "Is this a payment for a video game?",
    "Is this an insurance settlement?", "Was this a tip?", "Is this an invoice payment?", "Is this a rent payment?",
    "Is this a tax payment?", "Is this related to staking?", "Did a governance vote cause this?",
    "Is this a grant to a project?", "Is this a bug bounty?", "Is this money from a hack?", "Is this a scam?",
    "Is this part of a phishing attack?", "Are these stolen funds?", "Is the sender under sanctions?",
    "Is this going to a charity?", "Is this money being saved?", "Is this a cashback bonus?",
    "Is this a loyalty bonus?", "Is this a lottery win?", "Is this a crowdfunding contribution?", "Is this a prize?",
    "Is this a penalty payment?", "Did a company send this?", "Is this a business expense?",
    "Is this an allowance for a child?", "Is this a gift?", "Was this sent on a weekend?", "Is this a holiday bonus?",
    "Is this a pension payment?", "Was this sent automatically?", "Is this a court settlement?",
    "Is this a travel booking?", "Is this a utility bill payment?", "Is this a tuition payment?",
    "Is this a medical payment?", "Was a car paid for?", "Is this a down payment on a house?",
    "Was a freelancer paid?", "Is this a payment for software?", "Is this a payment for advertising?",
    "Is this a payment to a supplier?", "Is this money laundering?", "Is this a ransom payment?",
    "Did this money come from a bank?", "Is this a payment for food?", "Is this a wedding gift?",
    "Is this a government benefit?", "Is this an emergency transfer?", "Did a family member send this?",
    "Is this a refund for a cancelled trip?",
    "Bu bir airdrop mu?", "Bu bir iade mi?", "Bu bir bağış mı?", "Bu bir abonelik ödemesi mi?",
    "Bu bir kira ödemesi mi?", "Bu bir vergi ödemesi mi?", "Bu bir bahşiş mi?", "Bu bir fatura ödemesi mi?",
    "Bu bir hibe mi?", "Bu bir dolandırıcılık mı?", "Bu çalıntı para mı?", "Bu bir oyun ödemesi mi?",
    "Bu bir sigorta tazminatı mı?", "Bunu bir şirket mi gönderdi?", "Bu para bir hayır kurumuna mı gitti?",
    "Bu bir piyango kazancı mı?", "Bu bir hediye mi?", "Bu otomatik olarak mı gönderildi?",
)

AVOID = (
    # what the bank teaches
    "swap", "trade", "exchange", "bridge", "chain", "leaving", "arriv", "100", "10,000", "10k", "dollar", "cent",
    "zero", "dust", "wallet", "contract", "direct", "mint", "burn", "issu", "sign", "gas", "defi", "vault",
    "deposit", "withdr", "loan", "borrow", "lend", "repa", "wrap", "cctp", "relay", "circle",
    "takas", "borsa", "köprü", "zincir", "cüzdan", "kontrat", "basıl", "basım", "yakı", "imza", "gazsız", "kasa",
    "kredi", "borç", "sarmal", "sentten",
    # the held-out topics
    "smart account", "erc-4337", "fee", "commission", "charge", "liquidity", "pool", "batch", "recipients", "mass",
    "reward", "payout", "claim", "marketplace", "nft", "order", "spam", "junk", "uniswap", "aerodrome", "okx",
    "kyber", "1inch", "li.fi", "akıllı hesap", "ücret", "ödül", "likidite", "havuz", "toplu", "pazar",
    # what eval.py asks beyond the bank
    "arbitrage", "bot", "test", "ethereum", "payroll", "salary", "maaş", "buy a token", "signature", "tiny",
)


def sample(stories: list[str], seed: int = 0) -> dict[str, list[str]]:
    """EACH distinct replay questions per story, the same ones for the same seed."""
    rng = random.Random(seed)
    return {story: rng.sample(QUESTIONS, EACH) for story in sorted(stories)}


async def _post(endpoint: str, token: str, states: list[str], question: str) -> list[float]:
    headers = {"User-Agent": "arc-radar/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with httpx.AsyncClient(timeout=120.0, headers=headers) as client:
        response = await client.post(f"{endpoint.rstrip('/')}/ai/run/batch", json={
            "states": states, "questions": {"r": {"type": "noul", "instructions": question}}})
        response.raise_for_status()
        return [item["answers"]["r"]["noul"] for item in response.json()["results"]]


async def answer(endpoint: str, token: str, picked: dict[str, list[str]]) -> dict[str, dict[str, float]]:
    """The base's answer to every picked (story, question), asked as the server asks."""
    by_question: dict[str, list[str]] = {}
    for story, questions in picked.items():
        for q in questions:
            by_question.setdefault(q, []).append(story)
    out: dict[str, dict[str, float]] = {}
    for q, stories in by_question.items():
        stories = sorted(stories)
        for start in range(0, len(stories), CHUNK):
            chunk = stories[start:start + CHUNK]
            for story, p in zip(chunk, await _post(endpoint, token, chunk, RULE_PREFIX + q)):
                out.setdefault(story, {})[q] = round(float(p), 4)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--capture", type=Path, action="append", required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8918", help="the BASE model, never a fine-tune")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--token-env", default="RADAR_TOKEN")
    args = parser.parse_args(argv)
    for path in args.capture:
        if path.resolve() == FIXTURE.resolve():
            raise SystemExit(f"{path} is eval.py's benchmark; it never becomes training data")
    items = [it for path in args.capture for it in load(path)] + synth.items()
    stories = sorted({summarize(it)["story"] for it in items})
    answers = asyncio.run(answer(args.endpoint, os.environ.get(args.token_env, ""), sample(stories, args.seed)))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(answers, ensure_ascii=False, indent=0))
    print(f"{len(answers)} stories x {EACH} replay questions answered by {args.endpoint} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
