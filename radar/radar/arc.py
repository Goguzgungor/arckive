"""Every USDC transfer on Arc, as blocks land.

Polling rather than subscribing: Arc closes a block about every half second
and has instant finality, so a one-second `eth_blockNumber` poll followed by
one `eth_getLogs` over the new blocks sees everything with no reorg handling,
and works against every endpoint in the pool (not all of them offer
WebSockets).
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from .rpc import RpcPool
from .types import TRANSFER_TOPIC, USDC, ZERO, Item, Transfer, TxContext

LOG = logging.getLogger("radar.arc")

# How far behind the announced head the feed reads. Arc blocks are final, but
# the pool is not one node: the head can come from one endpoint and the logs
# from another that is a block or two behind, and a node asked for logs past
# its own tip answers an empty list rather than an error. Reading right up to
# the head would move the cursor past blocks that node had not seen yet and
# lose their transfers without a trace; two blocks (~1 s) of slack costs
# nothing a viewer can notice.
HEAD_TRAIL = 2


class CodeCache:
    """Whether an address has code. Contract-ness does not change in practice,
    and the same routers and pools appear in most transactions, so this cuts
    `eth_getCode` traffic to the handful of new wallets each block brings."""

    def __init__(self, size: int = 50_000) -> None:
        self._size = size
        self._data: OrderedDict[str, bool] = OrderedDict()

    def get(self, address: str) -> bool | None:
        if address not in self._data:
            return None
        self._data.move_to_end(address)
        return self._data[address]

    def put(self, address: str, has_code: bool) -> None:
        self._data[address] = has_code
        self._data.move_to_end(address)
        while len(self._data) > self._size:
            self._data.popitem(last=False)


def _address(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def _transfer(log: dict[str, Any]) -> Transfer:
    return {
        "tx": log["transactionHash"].lower(),
        "log_index": int(log["logIndex"], 16),
        "block": int(log["blockNumber"], 16),
        "frm": _address(log["topics"][1]),
        "to": _address(log["topics"][2]),
        "value": int(log["data"], 16) if log["data"] not in ("0x", "") else 0,
    }


def _context(tx: Any, receipt: Any) -> TxContext | None:
    if not isinstance(tx, dict) or not isinstance(receipt, dict):
        return None
    try:
        data = tx.get("input") or "0x"
        return {
            "to": tx["to"].lower() if tx.get("to") else None,
            "selector": data[:10].lower() if len(data) >= 10 else "0x",
            "topics": [lg["topics"][0].lower() for lg in receipt.get("logs", []) if lg.get("topics")],
        }
    except (AttributeError, IndexError, KeyError, TypeError):
        # A garbled transaction or receipt costs this transfer its context --
        # it is shown as unreadable -- rather than costing the feed its tick.
        return None


async def stream_transfers(
    pool: RpcPool,
    *,
    poll: float = 1.0,
    max_gap: int = 600,
    max_range: int = 1000,
    trail: int = HEAD_TRAIL,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    now: Callable[[], float] = time.time,
) -> AsyncIterator[Item]:
    codes = CodeCache()
    cursor: int | None = None
    while True:
        # Everything a tick reads from the network is untrusted, and the feed
        # is the one thing the wall cannot do without: any failure -- an
        # outage, a null head, an answer of the wrong shape -- costs one tick
        # and is retried from the same cursor, and nothing escapes this loop.
        try:
            tick = await _tick(pool, codes, cursor, trail=trail, max_gap=max_gap,
                               max_range=max_range, now=now)
        except Exception as exc:  # noqa: BLE001 - the feed outlives any one bad answer
            LOG.warning("feed tick failed (%s): %s", type(exc).__name__, exc)
            await sleep(poll)
            continue
        if tick is None:
            await sleep(poll)
            continue
        cursor, items = tick
        for item in items:
            yield item


async def _tick(
    pool: RpcPool, codes: CodeCache, cursor: int | None, *,
    trail: int, max_gap: int, max_range: int, now: Callable[[], float],
) -> tuple[int, list[Item]] | None:
    """Read the blocks since `cursor`: (next cursor, items), or None if none are new."""
    head = await pool.call("eth_blockNumber", [])
    if not isinstance(head, str):
        raise ValueError(f"eth_blockNumber answered {head!r}")
    head = max(int(head, 16) - trail, 0)
    if cursor is None:
        cursor = head
    if head < cursor:
        return None
    if head - cursor + 1 > max_gap:
        # A live wall, not an archive: after an outage, show what is
        # happening now rather than replaying minutes of history.
        LOG.info("behind by %d blocks, jumping to head", head - cursor + 1)
        cursor = head
    end = min(head, cursor + max_range - 1)
    logs = await pool.call("eth_getLogs", [{
        "fromBlock": hex(cursor), "toBlock": hex(end),
        "address": USDC, "topics": [TRANSFER_TOPIC],
    }])
    # `null` is not "no transfers": reading it as an empty range would move
    # the cursor over blocks nobody actually read.
    if not isinstance(logs, list):
        raise ValueError(f"eth_getLogs answered {type(logs).__name__}")
    return end + 1, (await _items(pool, codes, logs, now) if logs else [])


async def _items(
    pool: RpcPool, codes: CodeCache, logs: list[Any], now: Callable[[], float],
) -> list[Item]:
    """Turn one range of USDC logs into feed items, context and all.

    Built whole before anything is yielded, so a tick that fails part-way
    emits nothing and is retried cleanly instead of repeating half a range.
    """
    transfers = [_transfer(lg) for lg in logs]
    # One context fetch per transaction, not per transfer: a swap moves USDC
    # two or three times in one transaction and they all share its receipt.
    hashes = list(dict.fromkeys(t["tx"] for t in transfers))
    calls = [("eth_getTransactionByHash", [h]) for h in hashes] + \
            [("eth_getTransactionReceipt", [h]) for h in hashes]
    # The pool never raises from a batch: whatever no endpoint could answer
    # comes back as None, which _context turns into "no context".
    got = await pool.batch(calls, retry_null=True)
    ctx = {h: _context(got[i], got[i + len(hashes)]) for i, h in enumerate(hashes)}

    unknown = list(dict.fromkeys(
        a for t in transfers for a in (t["frm"], t["to"]) if a != ZERO and codes.get(a) is None
    ))
    if unknown:
        code = await pool.batch([("eth_getCode", [a, "latest"]) for a in unknown])
        for a, c in zip(unknown, code):
            if isinstance(c, str):
                codes.put(a, c not in ("0x", "0x0", ""))

    seen = now()
    items: list[Item] = []
    for t in transfers:
        parties = {a: codes.get(a) for a in (t["frm"], t["to"]) if a != ZERO}
        items.append({
            "transfer": t,
            "ctx": ctx[t["tx"]],
            "contracts": {a: v for a, v in parties.items() if v is not None},
            "seen_at": seen,
        })
    return items
