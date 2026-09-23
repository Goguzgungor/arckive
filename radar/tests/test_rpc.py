import asyncio
import json

import httpx
import pytest

from radar.rpc import RpcError, RpcPool, default_urls


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def handler_for(routes):
    """routes: url -> callable(request_json) -> httpx.Response. Records hits."""
    hits = []

    def handle(request: httpx.Request) -> httpx.Response:
        url = str(request.url).rstrip("/")
        body = json.loads(request.content)
        hits.append((url, body))
        return routes[url](body)

    return handle, hits


def ok(result):
    def respond(body):
        if isinstance(body, list):
            return httpx.Response(200, json=[{"jsonrpc": "2.0", "id": c["id"], "result": result(c)} for c in body])
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result(body)})
    return respond


def status(code):
    return lambda body: httpx.Response(code, text="nope")


def run(coro):
    return asyncio.run(coro)


A, B, C = "https://a", "https://b", "https://c"


def test_first_healthy_endpoint_answers():
    handle, hits = handler_for({A: ok(lambda c: "0x10"), B: ok(lambda c: "0x20")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle))
    assert run(pool.call("eth_blockNumber", [])) == "0x10"
    assert [h[0] for h in hits] == [A]


def test_429_fails_over_and_cools_down():
    clock = Clock()
    handle, hits = handler_for({A: status(429), B: ok(lambda c: "0x20")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle), clock=clock)
    assert run(pool.call("eth_blockNumber", [])) == "0x20"
    hits.clear()
    clock.now += 4.9  # still inside A's 5 s cooldown
    run(pool.call("eth_blockNumber", []))
    assert [h[0] for h in hits] == [B]
    hits.clear()
    clock.now += 0.2  # cooldown over, A is tried first again
    run(pool.call("eth_blockNumber", []))
    assert hits[0][0] == A


def test_cooldown_doubles_and_caps():
    clock = Clock()
    handle, _ = handler_for({A: status(503), B: ok(lambda c: "0x1")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle), clock=clock)
    waits = []
    for _ in range(6):
        run(pool.call("eth_blockNumber", []))
        waits.append(pool.cooling_until(A) - clock.now)
        clock.now = pool.cooling_until(A)  # let it expire so A is tried again
    assert waits == [5.0, 10.0, 20.0, 40.0, 60.0, 60.0]


def test_all_cooling_uses_soonest():
    clock = Clock()
    state = {"fail": True}

    def flaky(body):
        return status(429)(body) if state["fail"] else ok(lambda c: "0x2")(body)

    handle, hits = handler_for({A: status(429), B: flaky})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle), clock=clock)
    with pytest.raises(RpcError):
        run(pool.call("eth_blockNumber", []))
    # Both are cooling now; B's failure came second but both got 5 s.
    state["fail"] = False
    hits.clear()
    clock.now += 1.0
    assert run(pool.call("eth_blockNumber", [])) == "0x2"
    assert hits  # it tried something rather than raising without a request


def test_jsonrpc_error_moves_on_without_cooldown():
    clock = Clock()
    err = lambda body: httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32005, "message": "limit"}})
    handle, hits = handler_for({A: err, B: ok(lambda c: "0x5")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle), clock=clock)
    assert run(pool.call("eth_getLogs", [{}])) == "0x5"
    assert pool.cooling_until(A) <= clock.now


def test_batch_chunks_and_orders():
    handle, hits = handler_for({A: ok(lambda c: c["params"][0])})
    pool = RpcPool([A], transport=httpx.MockTransport(handle), chunk=20)
    calls = [("eth_getCode", [f"0x{i:040x}", "latest"]) for i in range(45)]
    out = run(pool.batch(calls))
    assert out == [f"0x{i:040x}" for i in range(45)]
    assert [len(h[1]) for h in hits] == [20, 20, 5]


def test_batch_retry_null_uses_next_endpoint():
    handle, hits = handler_for({
        A: ok(lambda c: None if c["params"][0] == "0xbad" else "fromA"),
        B: ok(lambda c: "fromB"),
    })
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle))
    out = run(pool.batch([("eth_getTransactionReceipt", ["0xgood"]), ("eth_getTransactionReceipt", ["0xbad"])], retry_null=True))
    assert out == ["fromA", "fromB"]
    assert [len(h[1]) for h in hits] == [2, 1]  # only the null one is re-asked


def test_batch_null_everywhere_stays_none():
    handle, _ = handler_for({A: ok(lambda c: None), B: ok(lambda c: None)})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle))
    assert run(pool.batch([("eth_getTransactionReceipt", ["0x1"])], retry_null=True)) == [None]


def test_default_urls(monkeypatch):
    monkeypatch.delenv("ARC_RPCS", raising=False)
    assert default_urls()[0] == "https://rpc.mainnet.arc.io"
    monkeypatch.setenv("ARC_RPCS", " https://x , ,https://y")
    assert default_urls() == ["https://x", "https://y"]


# 200 replies that are not JSON-RPC. Each one rests the endpoint like an
# outage and the call moves on, instead of reaching the caller as a value.
NOT_JSONRPC = {
    "no-result": lambda body: httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"]}),
    "list": lambda body: httpx.Response(200, json=[]),
    "bare-429": lambda body: httpx.Response(200, json={"code": 429, "message": "x"}),
}


@pytest.mark.parametrize("name", list(NOT_JSONRPC))
def test_call_rests_an_endpoint_that_answers_nonsense(name):
    clock = Clock()
    handle, hits = handler_for({A: NOT_JSONRPC[name], B: ok(lambda c: "0x20")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle), clock=clock)
    assert run(pool.call("eth_blockNumber", [])) == "0x20"
    assert pool.cooling_until(A) > clock.now


@pytest.mark.parametrize("name", list(NOT_JSONRPC))
def test_call_raises_only_rpc_error_when_nobody_makes_sense(name):
    handle, _ = handler_for({A: NOT_JSONRPC[name]})
    pool = RpcPool([A], transport=httpx.MockTransport(handle))
    with pytest.raises(RpcError):
        run(pool.call("eth_blockNumber", []))


def test_call_passes_a_null_result_through():
    # Null is a real answer for some methods (an unknown transaction); the
    # feed decides that it is not one for a head or a log range.
    handle, _ = handler_for({A: ok(lambda c: None)})
    pool = RpcPool([A], transport=httpx.MockTransport(handle))
    assert run(pool.call("eth_blockNumber", [])) is None


def test_string_error_moves_on():
    err = lambda body: httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "error": "limit"})
    handle, _ = handler_for({A: err, B: ok(lambda c: "0x5")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle))
    assert run(pool.call("eth_getLogs", [{}])) == "0x5"


def test_batch_skips_garbled_items_and_asks_again_elsewhere():
    def garbled(body):
        first = {"jsonrpc": "2.0", "id": body[0]["id"], "result": "fromA"}
        return httpx.Response(200, json=[first, 7, "x", None, {"jsonrpc": "2.0", "id": [1]}])

    handle, hits = handler_for({A: garbled, B: ok(lambda c: "fromB")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle))
    out = run(pool.batch([("eth_getCode", ["0x1", "latest"]), ("eth_getCode", ["0x2", "latest"])]))
    assert out == ["fromA", "fromB"]
    assert [len(h[1]) for h in hits] == [2, 1]  # only the unanswered one is re-asked


def test_batch_rests_an_endpoint_that_answers_an_object():
    clock = Clock()
    obj = lambda body: httpx.Response(200, json={"jsonrpc": "2.0", "id": None, "result": []})
    handle, _ = handler_for({A: obj, B: ok(lambda c: "fromB")})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle), clock=clock)
    assert run(pool.batch([("eth_getCode", ["0x1", "latest"])])) == ["fromB"]
    assert pool.cooling_until(A) > clock.now


def test_batch_never_raises_when_nobody_makes_sense():
    handle, _ = handler_for({A: NOT_JSONRPC["bare-429"], B: lambda body: httpx.Response(200, json=[1, 2])})
    pool = RpcPool([A, B], transport=httpx.MockTransport(handle))
    assert run(pool.batch([("eth_getTransactionReceipt", ["0x1"])], retry_null=True)) == [None]
