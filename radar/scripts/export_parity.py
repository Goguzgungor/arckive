"""Write what Radar says about each transfer, for the worker's port to match.

The worker rebuilds Radar's lane sentence in TypeScript
(packages/core/src/insights). Radar's measured accuracy carries over only if
the model reads the same text, so the port is tested against what this
module actually produces: one case per distinct sentence in the live capture,
plus the hand-made cases the capture does not contain (mint, burn, zero
transfers, unreadable transactions, unknown parties).

    cd radar && .venv/bin/python scripts/export_parity.py \
        > ../packages/core/test/fixtures/radar-parity.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from radar.summarize import summarize  # noqa: E402
from radar.types import USDC, ZERO  # noqa: E402

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
USER_OP = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"
WALLET = "0x" + "a1" * 20
WALLET2 = "0x" + "a2" * 20
POOL = "0x" + "b1" * 20
ROUTER = "0x" + "c1" * 20


def ctx(selector: str, to: str | None, topics: list[str]) -> dict:
    return {"to": to, "selector": selector, "topics": topics, "sender": WALLET,
            "emitters": [USDC] * len(topics), "factories": {}}


def item(frm=WALLET, to=WALLET2, value=12_000_000, context=None, contracts=None) -> dict:
    return {
        "transfer": {"tx": "0x" + "00" * 32, "log_index": 0, "block": 1, "frm": frm, "to": to, "value": value},
        "ctx": context,
        "contracts": {WALLET: False, WALLET2: False, POOL: True, ROUTER: True} if contracts is None else contracts,
        "seen_at": 0.0,
    }


HAND_MADE = [
    item(frm=ZERO, to=WALLET, context=ctx("0x", None, [TRANSFER])),                    # mint
    item(frm=POOL, to=ZERO, context=ctx("0xdeadbeef", POOL, [TRANSFER])),              # burn
    item(frm=ZERO, to=WALLET, context=ctx("0x57ecfd28", ROUTER, [TRANSFER])),          # bridge mint
    item(value=0, context=ctx("0xa9059cbb", USDC, [TRANSFER])),                        # zero, plain
    item(value=0, context=ctx("0x765e827f", ROUTER, [USER_OP])),                       # zero, smart account
    item(value=4_000, context=ctx("0x", WALLET2, [TRANSFER])),                         # sub-cent native send
    item(value=9_999, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=10_000, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=999_999, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=100_000_000, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(value=10_000_000_000, context=ctx("0xa9059cbb", USDC, [TRANSFER])),
    item(context=ctx("0xdeadbeef", POOL, [TRANSFER, "0x" + "12" * 32])),               # unknown contract
    item(context=None),                                                                # unreadable
    item(context=ctx("0xa9059cbb", USDC, [TRANSFER]), contracts={}),                   # unknown parties
]


def case(it: dict) -> dict:
    s = summarize(it)
    return {
        "transfer": {"frm": it["transfer"]["frm"], "to": it["transfer"]["to"], "value": str(it["transfer"]["value"])},
        "ctx": it["ctx"],
        "contracts": it["contracts"],
        "expected": {"shape": s["shape"], "ruled": s["ruled"], "facts": s["facts"], "protocol": s["protocol"]},
    }


def main() -> None:
    capture = json.loads((ROOT / "tests/fixtures/live_sample.json").read_text())
    live = []
    for it in capture["items"]:
        c = capture["txs"].get(it["transfer"]["tx"])
        if c is not None:
            c = {**c, "emitters": c.get("emitters", []), "factories": c.get("factories", {})}
        live.append({**it, "ctx": c})
    cases, seen = [], set()
    for it in live + HAND_MADE:
        out = case(it)
        key = json.dumps(out["expected"], sort_keys=True)
        if key not in seen:
            seen.add(key)
            cases.append(out)
    # One case per line: small, and a change to one sentence is a one-line diff.
    sys.stdout.write("[\n" + ",\n".join(json.dumps(c, separators=(",", ":")) for c in cases) + "\n]\n")


if __name__ == "__main__":
    main()
