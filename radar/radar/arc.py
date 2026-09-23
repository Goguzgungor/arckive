"""Every USDC transfer on Arc, as blocks land.

Polling rather than subscribing: Arc closes a block about every half second
and has instant finality, so a one-second `eth_blockNumber` poll followed by
one `eth_getLogs` over the new blocks sees everything with no reorg handling,
and works against every endpoint in the pool (not all of them offer
WebSockets).

"Every" means both ways USDC moves on Arc: through the ERC-20 interface at
USDC, and natively -- USDC is the chain's own currency, and a value send
never touches the ERC-20 contract. See NATIVE in types.py.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter, OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from .rpc import RpcPool
from .signatures import POOL_TOPICS
from .types import (
    DECIMALS, ENTRYPOINTS, NATIVE, NATIVE_DECIMALS, TRANSFER_TOPIC, USDC, ZERO, Item, Transfer, TxContext,
)

LOG = logging.getLogger("radar.arc")

# How far behind the announced head the feed reads. Arc blocks are final, but
# the pool is not one node: the head can come from one endpoint and the logs
# from another that is a block or two behind, and a node asked for logs past
# its own tip answers an empty list rather than an error. Reading right up to
# the head would move the cursor past blocks that node had not seen yet and
# lose their transfers without a trace; two blocks (~1 s) of slack costs
# nothing a viewer can notice.
HEAD_TRAIL = 2


# factory() -- the one view every Uniswap-v2 and -v3 style pool has.
FACTORY_CALL = "0xc45a0155"
# A pool whose factory() could not be read is asked again only after this
# long. A contract that logs a pool event but has no factory() fails the same
# way every time, and each failure is one request per endpoint in the pool.
FACTORY_RETRY = 600.0
_SCALE = 10 ** (NATIVE_DECIMALS - DECIMALS)


class CodeCache:
    """What is known about an address that does not change: whether it is a
    contract, or which factory deployed a pool. The same routers and pools
    appear in most transactions, so this cuts lookups to the handful of new
    addresses each block brings."""

    def __init__(self, size: int = 50_000) -> None:
        self._size = size
        self._data: OrderedDict[str, Any] = OrderedDict()

    def get(self, address: str) -> Any:
        if address not in self._data:
            return None
        self._data.move_to_end(address)
        return self._data[address]

    def put(self, address: str, value: Any) -> None:
        self._data[address] = value
        self._data.move_to_end(address)
        while len(self._data) > self._size:
            self._data.popitem(last=False)


def is_contract(code: str) -> bool:
    """Whether `eth_getCode` describes a contract rather than a wallet.

    An EIP-7702 account carries code too -- 0xef0100 and the address it
    delegates to, 23 bytes -- but it is still somebody's wallet with a key.
    On mainnet 268 of 663 addresses with code were these, most of them
    MetaMask accounts, and calling them contracts told the model that a
    payment between two people went from one contract to another.
    """
    if code in ("0x", "0x0", ""):
        return False
    return not (code.startswith("0xef0100") and len(code) == 2 + 2 * 23)


def _address(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def _raw(log: dict[str, Any]) -> int:
    return int(log["data"], 16) if log["data"] not in ("0x", "") else 0


def _native(log: dict[str, Any]) -> bool:
    return log.get("address", "").lower() == NATIVE


def _transfer(log: dict[str, Any]) -> Transfer:
    raw = _raw(log)
    return {
        "tx": log["transactionHash"].lower(),
        "log_index": int(log["logIndex"], 16),
        "block": int(log["blockNumber"], 16),
        "frm": _address(log["topics"][1]),
        "to": _address(log["topics"][2]),
        # Rounded up, so a native movement of a few wei is "less than one
        # cent" rather than a zero -- a zero transfer is the one thing the
        # spam lane is decided on.
        "value": -(-raw // _SCALE) if _native(log) else raw,
    }


def _without_mirrors(logs: list[Any]) -> list[Any]:
    """Drop the native twin of every ERC-20 USDC log.

    A transfer through the ERC-20 interface is logged by USDC and again by
    NATIVE, with the same parties and the value in 18 decimals. Each ERC-20
    log takes away one native log that matches it exactly; whatever native
    logs remain moved USDC without the ERC-20 interface and are kept.
    """
    twins: Counter[tuple[str, str, str, int]] = Counter()
    for lg in logs:
        if not _native(lg):
            t = _transfer(lg)
            twins[(t["tx"], t["frm"], t["to"], t["value"] * _SCALE)] += 1
    kept = []
    for lg in logs:
        if _native(lg):
            key = (lg["transactionHash"].lower(), _address(lg["topics"][1]), _address(lg["topics"][2]), _raw(lg))
            if twins[key]:
                twins[key] -= 1
                continue
        kept.append(lg)
    return kept


def _context(tx: Any, receipt: Any) -> TxContext | None:
    if not isinstance(tx, dict) or not isinstance(receipt, dict):
        return None
    try:
        data = tx.get("input") or "0x"
        logs = [lg for lg in receipt.get("logs", []) if lg.get("topics")]
        return {
            "to": tx["to"].lower() if tx.get("to") else None,
            "selector": data[:10].lower() if len(data) >= 10 else "0x",
            "topics": [lg["topics"][0].lower() for lg in logs],
            "sender": (tx.get("from") or "").lower(),
            "emitters": [(lg.get("address") or "").lower() for lg in logs],
            "factories": {},
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
    # Blocks per eth_getLogs. With native movements read too, a block carries
    # about four times the logs it did; a catch-up over hundreds of blocks in
    # one call could pass the result caps providers put on eth_getLogs, and a
    # refused range is retried whole. Smaller calls catch up over a few ticks.
    max_range: int = 200,
    trail: int = HEAD_TRAIL,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    now: Callable[[], float] = time.time,
) -> AsyncIterator[Item]:
    codes = CodeCache()
    factories = CodeCache()
    unreadable: dict[str, float] = {}  # pool -> when its factory() may be asked again
    cursor: int | None = None
    while True:
        # Everything a tick reads from the network is untrusted, and the feed
        # is the one thing the wall cannot do without: any failure -- an
        # outage, a null head, an answer of the wrong shape -- costs one tick
        # and is retried from the same cursor, and nothing escapes this loop.
        try:
            tick = await _tick(pool, codes, factories, unreadable, cursor, trail=trail, max_gap=max_gap,
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
    pool: RpcPool, codes: CodeCache, factories: CodeCache, unreadable: dict[str, float], cursor: int | None, *,
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
        "address": [USDC, NATIVE], "topics": [TRANSFER_TOPIC],
    }])
    # `null` is not "no transfers": reading it as an empty range would move
    # the cursor over blocks nobody actually read.
    if not isinstance(logs, list):
        raise ValueError(f"eth_getLogs answered {type(logs).__name__}")
    return end + 1, (await _items(pool, codes, factories, unreadable, logs, now) if logs else [])


async def _items(
    pool: RpcPool, codes: CodeCache, factories: CodeCache, unreadable: dict[str, float],
    logs: list[Any], now: Callable[[], float],
) -> list[Item]:
    """Turn one range of USDC logs into feed items, context and all.

    Built whole before anything is yielded, so a tick that fails part-way
    emits nothing and is retried cleanly instead of repeating half a range.
    """
    transfers = [_transfer(lg) for lg in _without_mirrors(logs)]
    # One context fetch per transaction, not per transfer: a swap moves USDC
    # two or three times in one transaction and they all share its receipt.
    hashes = list(dict.fromkeys(t["tx"] for t in transfers))
    calls = [("eth_getTransactionByHash", [h]) for h in hashes] + \
            [("eth_getTransactionReceipt", [h]) for h in hashes]
    # The pool never raises from a batch: whatever no endpoint could answer
    # comes back as None, which _context turns into "no context".
    got = await pool.batch(calls, retry_null=True)
    ctx = {h: _context(got[i], got[i + len(hashes)]) for i, h in enumerate(hashes)}

    # Which exchange a swap happened on is a fact about the pool, not about
    # the event it logs: Uniswap v3's Swap event is emitted, byte for byte, by
    # every fork of it. Measured on mainnet, 29% of the pools logging it were
    # Aerodrome's and others', so the pool is asked who deployed it.
    pools_of = {
        h: list(dict.fromkeys(e for e, t in zip(c["emitters"], c["topics"]) if t in POOL_TOPICS and e))
        for h, c in ctx.items() if c
    }
    clock = now()
    ask = list(dict.fromkeys(
        p for ps in pools_of.values() for p in ps
        if factories.get(p) is None and unreadable.get(p, 0.0) <= clock
    ))
    if ask:
        answers = await pool.batch([("eth_call", [{"to": p, "data": FACTORY_CALL}, "latest"]) for p in ask])
        for p, a in zip(ask, answers):
            if isinstance(a, str) and len(a) >= 42:
                factories.put(p, "0x" + a[-40:].lower())
                unreadable.pop(p, None)
            else:
                unreadable[p] = clock + FACTORY_RETRY
        if len(unreadable) > 10_000:
            for p in [p for p, until in unreadable.items() if until <= clock]:
                del unreadable[p]
    for h, c in ctx.items():
        if c:
            c["factories"] = {p: f for p in pools_of[h] if (f := factories.get(p))}

    unknown = list(dict.fromkeys(
        a for t in transfers for a in (t["frm"], t["to"]) if a != ZERO and codes.get(a) is None
    ))
    if unknown:
        code = await pool.batch([("eth_getCode", [a, "latest"]) for a in unknown])
        for a, c in zip(unknown, code):
            if isinstance(c, str):
                codes.put(a, is_contract(c))

    seen = clock
    items: list[Item] = []
    for t in transfers:
        c = ctx[t["tx"]]
        if c and t["frm"] in ENTRYPOINTS and t["to"] == c["sender"]:
            # The bundler taking its gas back (see ENTRYPOINTS). Shown, it was
            # a sub-cent row on every smart-account transaction, filed as spam.
            continue
        parties = {a: codes.get(a) for a in (t["frm"], t["to"]) if a != ZERO}
        items.append({
            "transfer": t,
            "ctx": c,
            "contracts": {a: v for a, v in parties.items() if v is not None},
            "seen_at": seen,
        })
    return items
