"""Capture live Arc USDC transfers, through the real feed, as the eval's fixture.

    .venv/bin/python scripts/capture.py 1500              # the next 1,500 transfers
    .venv/bin/python scripts/capture.py 1500 --every 4    # one in four, over ~4x as long
    .venv/bin/python scripts/capture.py 1500 --out /tmp/big.json

Transfers in one transaction share its context, so each context is stored
once, keyed by transaction; `load` puts the items back together.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from radar.arc import stream_transfers
from radar.rpc import RpcPool, default_urls

FIXTURE = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "live_sample.json"


def load(path: Path = FIXTURE) -> list[dict[str, Any]]:
    data = json.loads(Path(path).read_text())
    return [{**item, "ctx": data["txs"].get(item["transfer"]["tx"])} for item in data["items"]]


async def main(n: int, every: int, out: Path) -> None:
    pool = RpcPool(default_urls())
    items, txs, seen = [], {}, 0
    async for item in stream_transfers(pool):
        seen += 1
        if seen % every:
            continue
        txs[item["transfer"]["tx"]] = item["ctx"]
        items.append({k: v for k, v in item.items() if k != "ctx"})
        if len(items) >= n:
            break
    await pool.close()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"items": items, "txs": txs}, separators=(",", ":")))
    missing = sum(1 for c in txs.values() if c is None)
    print(f"wrote {len(items)} transfers in {len(txs)} transactions to {out} ({missing} without context)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("n", type=int, nargs="?", default=1500)
    parser.add_argument("--every", type=int, default=1)
    parser.add_argument("--out", type=Path, default=FIXTURE)
    args = parser.parse_args()
    asyncio.run(main(args.n, args.every, args.out))
