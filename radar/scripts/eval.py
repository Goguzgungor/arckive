"""How often Laya's lane agrees with the rule label, on captured live transfers.

    .venv/bin/python scripts/eval.py            # needs layad on LAYA_ENDPOINT

The rule label is what the signature table alone would say.  The model is not
graded on reproducing it for its own sake: a lane that disagrees with the
obvious reading of a transaction here will disagree on the wall too, and this
is the cheapest place to see it.  Bar: 85%.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import Counter
from pathlib import Path

from radar.classify import Classifier
from radar.summarize import facts_of, summarize
from radar.types import ZERO

SAMPLE = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "live_sample.json"
BAR = 0.85

# layad's GPU is shared with another live radar: a cold-cache batch of 400
# long Arc sentences held it for ~13s and made that radar drop work. Capping
# eval calls at the same size the server uses keeps this script from being
# the thing that causes that again.
CHUNK = 64


def rule_label(item) -> str | None:
    t, ctx = item["transfer"], item["ctx"]
    facts = facts_of(ctx)
    if (t["frm"] == ZERO or t["to"] == ZERO) and "bridge" not in facts:
        return "issuance"
    for fact, lane in (("bridge", "bridge"), ("swap", "swap"), ("liquidity", "liquidity"),
                       ("lending", "lending"), ("vault", "vault"), ("signed", "signed_payment")):
        if fact in facts:
            return lane
    shape = summarize(item)["shape"]
    if "it was a plain direct transfer" in shape:
        return "payment"
    if not facts and t["value"] < 10_000:
        return "spam"
    return None


async def main() -> int:
    items = json.loads(SAMPLE.read_text())
    c = Classifier(os.environ.get("LAYA_ENDPOINT", "http://127.0.0.1:8918"), token=os.environ.get("RADAR_TOKEN", ""))
    shapes = [summarize(i)["shape"] for i in items]

    # Distinct shapes only, sent a chunk at a time: the classifier already
    # caches per exact text, so sending duplicates or one 400-wide call would
    # just hold the model longer for the same answers.
    distinct = list(dict.fromkeys(shapes))
    by_shape: dict[str, dict] = {}
    for start in range(0, len(distinct), CHUNK):
        chunk = distinct[start:start + CHUNK]
        results = await c.classify(chunk)
        by_shape.update(zip(chunk, results))
    await c.close()
    answers = [by_shape[s] for s in shapes]

    ok = total = 0
    confusion: Counter[tuple[str, str]] = Counter()
    conf = []
    for item, shape, ans in zip(items, shapes, answers):
        conf.append(ans["lane_p"])
        want = rule_label(item)
        if want is None:
            continue
        total += 1
        if ans["lane"] == want:
            ok += 1
        else:
            confusion[(want, ans["lane"])] += 1
    rate = ok / total if total else 0.0
    print(f"distinct shapes: {len(set(shapes))} of {len(shapes)}")
    print(f"agreement: {ok}/{total} = {rate:.0%}   mean confidence {sum(conf)/len(conf):.2f}")
    for (want, got), n in confusion.most_common(10):
        print(f"  {n:4d}  expected {want:15s} got {got}")
    return 0 if rate >= BAR else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
