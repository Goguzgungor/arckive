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
    if isinstance(obj, (list, tuple)):  # laya keeps the per-type temperatures as a list
        return [clamp(v, low, high) for v in obj]
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
