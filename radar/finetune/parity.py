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
