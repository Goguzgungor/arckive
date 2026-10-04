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
    answers = [{"rules": {}, "stuck": False} for _ in summaries]
    for start in range(0, len(summaries), CHUNK):
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
