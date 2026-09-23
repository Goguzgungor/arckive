"""Capture live Arc USDC transfers as test fixtures for the lane eval.

    .venv/bin/python scripts/capture.py 400
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from radar.arc import stream_transfers
from radar.rpc import RpcPool, default_urls

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "live_sample.json"


async def main(n: int) -> None:
    pool = RpcPool(default_urls())
    items = []
    async for item in stream_transfers(pool):
        items.append(item)
        if len(items) >= n:
            break
    await pool.close()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(items, indent=1))
    missing = sum(1 for i in items if i["ctx"] is None)
    print(f"wrote {len(items)} transfers to {OUT} ({missing} without tx context)")


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 400))
