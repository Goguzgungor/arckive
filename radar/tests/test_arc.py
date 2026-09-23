import asyncio
import json

import httpx
import pytest

from radar.arc import HEAD_TRAIL, CodeCache, stream_transfers
from radar.rpc import RpcError, RpcPool
from radar.types import TRANSFER_TOPIC, USDC

A1 = "0x" + "11" * 20
A2 = "0x" + "22" * 20
C1 = "0x" + "cc" * 20


def topic(addr):
    return "0x" + "0" * 24 + addr[2:]


def log(tx, index, frm, to, value, block):
    return {"transactionHash": tx, "logIndex": hex(index), "blockNumber": hex(block),
            "address": USDC, "topics": [TRANSFER_TOPIC, topic(frm), topic(to)], "data": hex(value)}


class FakePool:
    """`heads` are the blocks the feed should read up to; the pool announces
    each one HEAD_TRAIL blocks later, the way a real head runs ahead of the
    feed. A None head is a node answering `result: null`."""

    def __init__(self, heads, logs_by_range=None, receipts=None, codes=None, fail_logs=0,
                 null_logs=0, trail=HEAD_TRAIL):
        self.heads = list(heads)
        self.logs_by_range = logs_by_range or {}
        self.receipts = receipts or {}
        self.codes = codes or {}
        self.fail_logs = fail_logs
        self.null_logs = null_logs
        self.trail = trail
        self.calls = []
        self.batches = []

    async def call(self, method, params):
        self.calls.append((method, params))
        if method == "eth_blockNumber":
            head = self.heads.pop(0) if len(self.heads) > 1 else self.heads[0]
            return None if head is None else hex(head + self.trail)
        if method == "eth_getLogs":
            if self.fail_logs:
                self.fail_logs -= 1
                raise RpcError("boom")
            if self.null_logs:
                self.null_logs -= 1
                return None
            f, t = int(params[0]["fromBlock"], 16), int(params[0]["toBlock"], 16)
            return self.logs_by_range.get((f, t), [])
        raise AssertionError(method)

    async def batch(self, calls, *, retry_null=False):
        self.batches.append(calls)
        out = []
        for method, params in calls:
            if method == "eth_getTransactionByHash":
                r = self.receipts.get(params[0])
                out.append(None if r is None else {"to": r["to"], "input": r["input"]})
            elif method == "eth_getTransactionReceipt":
                r = self.receipts.get(params[0])
                out.append(None if r is None else {"logs": [{"topics": [t]} for t in r["topics"]]})
            elif method == "eth_getCode":
                out.append("0x6080" if self.codes.get(params[0]) else "0x")
            else:
                raise AssertionError(method)
        return out


async def no_sleep(_):
    return None


async def take(gen, n):
    out = []
    async for item in gen:
        out.append(item)
        if len(out) == n:
            break
    return out


def test_first_tick_reads_head_block_only():
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [log("0xt1", 0, A1, C1, 5_000_000, 100)]},
                    receipts={"0xt1": {"to": C1, "input": "0x0c307f76abcdef", "topics": [TRANSFER_TOPIC]}},
                    codes={C1: True})
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep, now=lambda: 5.0), 1))
    assert item["transfer"] == {"tx": "0xt1", "log_index": 0, "block": 100, "frm": A1, "to": C1, "value": 5_000_000}
    assert item["ctx"] == {"to": C1, "selector": "0x0c307f76", "topics": [TRANSFER_TOPIC]}
    assert item["contracts"] == {A1: False, C1: True}
    assert item["seen_at"] == 5.0


def test_cursor_advances_over_new_blocks():
    pool = FakePool(heads=[100, 103],
                    logs_by_range={(100, 100): [], (101, 103): [log("0xt2", 4, A1, A2, 1, 102)]},
                    receipts={"0xt2": {"to": USDC, "input": "0xa9059cbb00", "topics": [TRANSFER_TOPIC]}})
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    assert item["transfer"]["block"] == 102
    ranges = [(int(p[0]["fromBlock"], 16), int(p[0]["toBlock"], 16)) for m, p in pool.calls if m == "eth_getLogs"]
    assert ranges == [(100, 100), (101, 103)]


def test_gap_older_than_limit_jumps_to_head():
    pool = FakePool(heads=[100, 2000], logs_by_range={(100, 100): [], (2000, 2000): [log("0xt3", 0, A1, A2, 1, 2000)]},
                    receipts={"0xt3": {"to": USDC, "input": "0x", "topics": [TRANSFER_TOPIC]}})
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep, max_gap=600), 1))
    assert item["transfer"]["block"] == 2000
    ranges = [(int(p[0]["fromBlock"], 16), int(p[0]["toBlock"], 16)) for m, p in pool.calls if m == "eth_getLogs"]
    assert ranges == [(100, 100), (2000, 2000)]


def test_missing_receipt_emits_without_context():
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [log("0xgone", 0, A1, A2, 1, 100)]})
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    assert item["ctx"] is None


def test_many_transfers_are_batched():
    logs = [log(f"0xt{i}", i, A1, A2, 1, 100) for i in range(50)]
    receipts = {f"0xt{i}": {"to": USDC, "input": "0x", "topics": [TRANSFER_TOPIC]} for i in range(50)}
    pool = FakePool(heads=[100], logs_by_range={(100, 100): logs}, receipts=receipts)
    items = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 50))
    assert len(items) == 50
    # one batch for tx+receipt (the pool chunks it), one for getCode — never per transfer
    assert len(pool.batches) == 2
    assert [m for m, _ in pool.batches[0]].count("eth_getTransactionReceipt") == 50


def test_code_is_cached_between_ticks():
    pool = FakePool(heads=[100, 101],
                    logs_by_range={(100, 100): [log("0xa", 0, A1, C1, 1, 100)], (101, 101): [log("0xb", 0, A1, C1, 1, 101)]},
                    receipts={"0xa": {"to": C1, "input": "0x", "topics": []}, "0xb": {"to": C1, "input": "0x", "topics": []}},
                    codes={C1: True})
    asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 2))
    code_calls = [c for b in pool.batches for c in b if c[0] == "eth_getCode"]
    assert len(code_calls) == 2  # A1 and C1 once each


def test_failed_getlogs_retries_same_range():
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [log("0xt", 0, A1, A2, 1, 100)]},
                    receipts={"0xt": {"to": USDC, "input": "0x", "topics": []}}, fail_logs=1)
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    assert item["transfer"]["tx"] == "0xt"


def test_code_cache_is_lru():
    cache = CodeCache(size=2)
    cache.put("a", True); cache.put("b", False)
    assert cache.get("a") is True     # touches a
    cache.put("c", True)              # evicts b
    assert cache.get("b") is None
    assert cache.get("a") is True and cache.get("c") is True


def ranges(pool):
    return [(int(p[0]["fromBlock"], 16), int(p[0]["toBlock"], 16)) for m, p in pool.calls if m == "eth_getLogs"]


def test_reads_two_blocks_behind_the_announced_head():
    # The head can come from one endpoint and the logs from a slower one; a
    # read right up to the head would skip what the slower one has not seen.
    pool = FakePool(heads=[102], trail=0, logs_by_range={(100, 100): [log("0xt", 0, A1, A2, 1, 100)]},
                    receipts={"0xt": {"to": USDC, "input": "0x", "topics": []}})
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    assert item["transfer"]["block"] == 100
    assert ranges(pool) == [(100, 100)]


def test_null_head_is_a_failed_tick():
    slept = []

    async def sleep(s):
        slept.append(s)

    pool = FakePool(heads=[None, 100], logs_by_range={(100, 100): [log("0xt", 0, A1, A2, 1, 100)]},
                    receipts={"0xt": {"to": USDC, "input": "0x", "topics": []}})
    [item] = asyncio.run(take(stream_transfers(pool, sleep=sleep), 1))
    assert item["transfer"]["tx"] == "0xt"
    assert slept == [1.0]


def test_null_logs_retry_the_same_range():
    # `null` is not an empty range: the cursor must not move past blocks that
    # were never actually read.
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [log("0xt", 0, A1, A2, 1, 100)]},
                    receipts={"0xt": {"to": USDC, "input": "0x", "topics": []}}, null_logs=1)
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    assert item["transfer"]["tx"] == "0xt"
    assert ranges(pool) == [(100, 100), (100, 100)]


def test_two_transfers_in_one_tx_share_one_context_fetch():
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [
                        log("0xswap", 0, A1, C1, 5_000_000, 100), log("0xswap", 3, C1, A2, 4_900_000, 100)]},
                    receipts={"0xswap": {"to": C1, "input": "0x0c307f76", "topics": [TRANSFER_TOPIC]}},
                    codes={C1: True})
    first, second = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 2))
    context_calls = [m for m, _ in pool.batches[0]]
    assert context_calls == ["eth_getTransactionByHash", "eth_getTransactionReceipt"]
    assert first["ctx"] == second["ctx"] == {"to": C1, "selector": "0x0c307f76", "topics": [TRANSFER_TOPIC]}


def test_garbled_receipt_costs_only_its_context():
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [log("0xt", 0, A1, A2, 1, 100)]})

    async def garbled(calls, *, retry_null=False):
        pool.batches.append(calls)
        return ["not a transaction" if m != "eth_getCode" else "0x" for m, _ in calls]
    pool.batch = garbled
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    assert item["ctx"] is None


# What real endpoints have been seen to answer with status 200 instead of a
# JSON-RPC reply. Each one used to raise out of the generator and end the
# feed for good; now each costs one tick.
MALFORMED = [
    {"jsonrpc": "2.0", "id": 1},
    [],
    {"code": 429, "message": "rate limited"},
    {"jsonrpc": "2.0", "id": 1, "result": None},
    {"jsonrpc": "2.0", "id": 1, "result": 12},
]


@pytest.mark.parametrize("bad", MALFORMED, ids=["no-result", "list", "bare-429", "null", "not-hex"])
def test_malformed_head_answer_never_ends_the_feed(bad):
    state = {"bad": 2}

    def handle(request):
        body = json.loads(request.content)
        if isinstance(body, list):  # tx, receipt and code lookups
            return httpx.Response(200, json=[{"jsonrpc": "2.0", "id": c["id"], "result": None} for c in body])
        if body["method"] == "eth_blockNumber":
            if state["bad"]:
                state["bad"] -= 1
                return httpx.Response(200, json=bad)
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": hex(100 + HEAD_TRAIL)})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"],
                                         "result": [log("0xt", 0, A1, A2, 1, 100)]})

    slept = []

    async def sleep(s):
        slept.append(s)

    pool = RpcPool(["https://a"], transport=httpx.MockTransport(handle))
    [item] = asyncio.run(take(stream_transfers(pool, sleep=sleep), 1))
    assert item["transfer"]["tx"] == "0xt"
    assert len(slept) == 2  # one failed tick per bad answer, then the feed carried on
