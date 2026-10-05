"""A fine-tune moved only part of the way from the base: WiSE-FT weight interpolation.

    .venv-ft/bin/python -m finetune.blend --ft "$RUN/final" --alpha 0.5 --out "$RUN/blend-0.5"

Run 3 (2026-10-04) taught the bank well and kept the gate whole, but on the
test capture a few questions it was never taught read worse than the base did
-- Turkish "ücret" (AUC 0.77 -> 0.46), "a worthless spam transfer" (0.99 ->
0.82), "a meta-transaction" (1.00 -> 0.36). Averaging a fine-tune's weights
with the model it started from is the standard cheap remedy (Wortsman et al.,
"Robust fine-tuning of zero-shot models", 2022): the blend keeps most of what
fine-tuning gained in its domain and much of what the base could do outside
it, with no new training. alpha is how far toward the fine-tune: 1 is the
fine-tune, 0 the base.

The blend keeps the fine-tune's config (budgets and its fitted temperatures);
both checkpoints share one architecture, so every weight has a partner.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

BASE_REPO = "convaiinnovations/laya-multilingual"
BASE_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"


def blend(base: dict[str, Any], ft: dict[str, Any], alpha: float) -> dict[str, Any]:
    """Each weight alpha of the way from the base's to the fine-tune's."""
    if not 0.0 <= alpha <= 1.0:
        raise ValueError(f"alpha must be in [0, 1], got {alpha}")
    if set(base) != set(ft):
        raise ValueError("both checkpoints must hold the same weights; "
                         f"only in base: {sorted(set(base) - set(ft))[:3]}, only in ft: {sorted(set(ft) - set(base))[:3]}")
    return {k: base[k] + alpha * (ft[k] - base[k]) for k in ft}


def main() -> int:
    from huggingface_hub import snapshot_download
    from safetensors.torch import load_file, save_file

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--ft", type=Path, required=True, help="the fine-tuned checkpoint directory (final/)")
    parser.add_argument("--alpha", type=float, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    base_dir = Path(snapshot_download(BASE_REPO, revision=BASE_REVISION))
    base = {k: v.float() for k, v in load_file(str(base_dir / "model.safetensors")).items()}
    ft = {k: v.float() for k, v in load_file(str(args.ft / "model.safetensors")).items()}
    mixed = blend(base, ft, args.alpha)
    if args.out.exists():
        shutil.rmtree(args.out)
    shutil.copytree(args.ft, args.out, ignore=shutil.ignore_patterns("model.safetensors", "manifest.json"))
    save_file({k: v.half().contiguous() for k, v in mixed.items()}, str(args.out / "model.safetensors"))
    manifest = json.loads((args.ft / "manifest.json").read_text()) if (args.ft / "manifest.json").exists() else {}
    manifest["blend"] = {"alpha": args.alpha, "base": f"{BASE_REPO}@{BASE_REVISION}", "ft": str(args.ft)}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"out": str(args.out), "alpha": args.alpha, "weights": len(mixed)}))
    return 0


if __name__ == "__main__":
    os.environ.setdefault("USE_TF", "0")
    sys.exit(main())
