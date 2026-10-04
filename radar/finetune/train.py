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
