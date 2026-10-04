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
