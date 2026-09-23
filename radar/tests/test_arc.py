import asyncio
import json

import httpx
import pytest

from radar.arc import HEAD_TRAIL, CodeCache, is_contract, stream_transfers
from radar.rpc import RpcError, RpcPool
from radar.types import ENTRYPOINTS, NATIVE, TRANSFER_TOPIC, USDC

A1 = "0x" + "11" * 20
A2 = "0x" + "22" * 20
C1 = "0x" + "cc" * 20
SENDER = "0x" + "5e" * 20
V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
UNI_V3 = "0xf0db7b58379503491d857db50ac9ece64c653918"


def topic(addr):
    return "0x" + "0" * 24 + addr[2:]


def log(tx, index, frm, to, value, block, address=USDC):
    return {"transactionHash": tx, "logIndex": hex(index), "blockNumber": hex(block),
            "address": address, "topics": [TRANSFER_TOPIC, topic(frm), topic(to)], "data": hex(value)}


def native(tx, index, frm, to, wei, block):
    return log(tx, index, frm, to, wei, block, address=NATIVE)


def ctx(to, selector, topics, emitters=None, factories=None, sender=SENDER):
    return {"to": to, "selector": selector, "topics": topics, "sender": sender,
            "emitters": emitters if emitters is not None else [USDC] * len(topics),
            "factories": factories or {}}


class FakePool:
    """`heads` are the blocks the feed should read up to; the pool announces
    each one HEAD_TRAIL blocks later, the way a real head runs ahead of the
    feed. A None head is a node answering `result: null`."""

    def __init__(self, heads, logs_by_range=None, receipts=None, codes=None, fail_logs=0,
                 null_logs=0, trail=HEAD_TRAIL, factories=None):
        self.heads = list(heads)
        self.logs_by_range = logs_by_range or {}
        self.receipts = receipts or {}
        self.codes = codes or {}
        self.factories = factories or {}
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
                out.append(None if r is None else {"to": r["to"], "input": r["input"], "from": r.get("from", SENDER)})
            elif method == "eth_getTransactionReceipt":
                r = self.receipts.get(params[0])
                emitters = r.get("emitters", [USDC] * len(r["topics"])) if r else []
                out.append(None if r is None else
                           {"logs": [{"address": a, "topics": [t]} for a, t in zip(emitters, r["topics"])]})
            elif method == "eth_getCode":
                code = self.codes.get(params[0])
                out.append(code if isinstance(code, str) else "0x6080" if code else "0x")
            elif method == "eth_call":
                factory = self.factories.get(params[0]["to"])
                out.append(None if factory is None else "0x" + "0" * 24 + factory[2:])
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
    assert item["ctx"] == ctx(C1, "0x0c307f76", [TRANSFER_TOPIC])
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
    assert first["ctx"] == second["ctx"] == ctx(C1, "0x0c307f76", [TRANSFER_TOPIC])


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


# ---- native USDC, gas refunds, wallets and pools -----------------------------

def test_logs_are_read_from_both_ways_usdc_moves():
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [log("0xt", 0, A1, A2, 1, 100)]},
                    receipts={"0xt": {"to": USDC, "input": "0x", "topics": []}})
    asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    [params] = [p for m, p in pool.calls if m == "eth_getLogs"]
    assert params[0]["address"] == [USDC, NATIVE]


def test_an_erc20_transfer_is_one_item_not_two():
    # Through the ERC-20 interface one movement is logged twice: natively in
    # 18 decimals, then by USDC in 6. Counting both doubled every swap leg.
    pool = FakePool(heads=[100, 101], logs_by_range={
                        (100, 100): [native("0xt", 0, A1, C1, 5_000_000 * 10**12, 100),
                                     log("0xt", 1, A1, C1, 5_000_000, 100)],
                        (101, 101): [log("0xnext", 0, A1, A2, 1, 101)]},
                    receipts={"0xt": {"to": C1, "input": "0x0c307f76", "topics": [TRANSFER_TOPIC, TRANSFER_TOPIC]},
                              "0xnext": {"to": USDC, "input": "0x", "topics": [TRANSFER_TOPIC]}},
                    codes={C1: True})
    first, second = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 2))
    assert (first["transfer"]["tx"], first["transfer"]["log_index"], first["transfer"]["value"]) == ("0xt", 1, 5_000_000)
    assert second["transfer"]["tx"] == "0xnext"


def test_a_native_only_movement_is_kept_and_never_reads_as_zero():
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [
                        native("0xv", 0, A1, A2, 2_500_000_000_000, 100),   # 2.5 micro-USDC
                        native("0xw", 0, A1, A2, 7, 100)]},                  # 7 wei
                    receipts={"0xv": {"to": A2, "input": "0x", "topics": [TRANSFER_TOPIC]},
                              "0xw": {"to": A2, "input": "0x", "topics": [TRANSFER_TOPIC]}})
    first, second = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 2))
    assert first["transfer"]["value"] == 3
    assert second["transfer"]["value"] == 1


def test_the_bundler_taking_its_gas_back_is_not_shown():
    entrypoint = sorted(ENTRYPOINTS)[0]
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [
                        log("0xop", 0, A1, C1, 9_000_000, 100),
                        native("0xop", 4, entrypoint, SENDER, 9_322 * 10**12, 100),
                        native("0xop", 5, entrypoint, A2, 1_000 * 10**12, 100)]},   # not the bundler
                    receipts={"0xop": {"to": entrypoint, "input": "0x765e827f", "topics": [TRANSFER_TOPIC]}},
                    codes={C1: True})
    items = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 2))
    assert [(i["transfer"]["frm"], i["transfer"]["to"]) for i in items] == [(A1, C1), (entrypoint, A2)]


def test_a_7702_delegated_account_is_a_wallet():
    assert is_contract("0x6080604052") is True
    assert is_contract("0x") is False
    assert is_contract("0xef0100" + "63c0c19a282a1b52b07dd5a65b58948a07dae32b") is False
    assert is_contract("0xef0100" + "63c0c19a282a1b52b07dd5a65b58948a07dae32b" + "00") is True
    delegated = "0xef0100" + "63c0c19a282a1b52b07dd5a65b58948a07dae32b"
    pool = FakePool(heads=[100], logs_by_range={(100, 100): [log("0xt", 0, A1, A2, 1, 100)]},
                    receipts={"0xt": {"to": USDC, "input": "0xa9059cbb", "topics": [TRANSFER_TOPIC]}},
                    codes={A1: delegated, A2: "0x6080"})
    [item] = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 1))
    assert item["contracts"] == {A1: False, A2: True}


def test_swapping_pools_are_asked_their_factory_once():
    receipt = {"to": C1, "input": "0x", "topics": [V3_SWAP, TRANSFER_TOPIC], "emitters": [C1, USDC]}
    pool = FakePool(heads=[100, 101],
                    logs_by_range={(100, 100): [log("0xa", 1, C1, A1, 1, 100)], (101, 101): [log("0xb", 1, C1, A1, 1, 101)]},
                    receipts={"0xa": receipt, "0xb": receipt}, codes={C1: True}, factories={C1: UNI_V3})
    first, second = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 2))
    assert first["ctx"]["factories"] == second["ctx"]["factories"] == {C1: UNI_V3}
    assert first["ctx"]["emitters"] == [C1, USDC]
    assert len([c for b in pool.batches for c in b if c[0] == "eth_call"]) == 1


def test_a_failed_factory_lookup_is_asked_again():
    receipt = {"to": C1, "input": "0x", "topics": [V3_SWAP], "emitters": [C1]}
    pool = FakePool(heads=[100, 101],
                    logs_by_range={(100, 100): [log("0xa", 1, C1, A1, 1, 100)], (101, 101): [log("0xb", 1, C1, A1, 1, 101)]},
                    receipts={"0xa": receipt, "0xb": receipt}, codes={C1: True})
    first, _ = asyncio.run(take(stream_transfers(pool, sleep=no_sleep), 2))
    assert first["ctx"]["factories"] == {}
    assert len([c for b in pool.batches for c in b if c[0] == "eth_call"]) == 2
