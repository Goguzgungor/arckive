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

from .rpc import RpcError, RpcPool
from .types import TRANSFER_TOPIC, USDC, ZERO, Item, Transfer, TxContext

LOG = logging.getLogger("radar.arc")


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


def _context(tx: dict[str, Any] | None, receipt: dict[str, Any] | None) -> TxContext | None:
    if tx is None or receipt is None:
        return None
    data = tx.get("input") or "0x"
    return {
        "to": tx["to"].lower() if tx.get("to") else None,
        "selector": data[:10].lower() if len(data) >= 10 else "0x",
        "topics": [lg["topics"][0].lower() for lg in receipt.get("logs", []) if lg.get("topics")],
    }


async def stream_transfers(
    pool: RpcPool,
    *,
    poll: float = 1.0,
    max_gap: int = 600,
    max_range: int = 1000,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    now: Callable[[], float] = time.time,
) -> AsyncIterator[Item]:
    codes = CodeCache()
    cursor: int | None = None
    while True:
        try:
            head = int(await pool.call("eth_blockNumber", []), 16)
            if cursor is None:
                cursor = head
            if head < cursor:
                await sleep(poll)
                continue
            if head - cursor + 1 > max_gap:
                # A live wall, not an archive: after an outage, show what is
                # happening now rather than replaying minutes of history.
                LOG.info("behind by %d blocks, jumping to head", head - cursor + 1)
                cursor = head
            end = min(head, cursor + max_range - 1)
            logs = await pool.call("eth_getLogs", [{
                "fromBlock": hex(cursor), "toBlock": hex(end),
                "address": USDC, "topics": [TRANSFER_TOPIC],
            }]) or []
        except RpcError as exc:
            LOG.warning("feed tick failed: %s", exc)
            await sleep(poll)
            continue
        cursor = end + 1
        if not logs:
            continue

        transfers = [_transfer(lg) for lg in logs]
        hashes = list(dict.fromkeys(t["tx"] for t in transfers))
        calls = [("eth_getTransactionByHash", [h]) for h in hashes] + \
                [("eth_getTransactionReceipt", [h]) for h in hashes]
        try:
            got = await pool.batch(calls, retry_null=True)
        except RpcError as exc:
            LOG.warning("tx context unavailable: %s", exc)
            got = [None] * len(calls)
        ctx = {h: _context(got[i], got[i + len(hashes)]) for i, h in enumerate(hashes)}

        unknown = list(dict.fromkeys(
            a for t in transfers for a in (t["frm"], t["to"]) if a != ZERO and codes.get(a) is None
        ))
        if unknown:
            try:
                code = await pool.batch([("eth_getCode", [a, "latest"]) for a in unknown])
                for a, c in zip(unknown, code):
                    if c is not None:
                        codes.put(a, c not in ("0x", "0x0", ""))
            except RpcError as exc:
                LOG.warning("getCode unavailable: %s", exc)

        seen = now()
        for t in transfers:
            parties = {a: codes.get(a) for a in (t["frm"], t["to"]) if a != ZERO}
            yield {
                "transfer": t,
                "ctx": ctx[t["tx"]],
                "contracts": {a: v for a, v in parties.items() if v is not None},
                "seen_at": seen,
            }
