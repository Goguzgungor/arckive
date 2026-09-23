import asyncio
import json

import httpx
import pytest

from radar import classify
from radar.classify import LANES, Classifier
from radar.gate import PROBES


def test_lanes_are_the_nine_from_the_spec():
    assert list(LANES) == ["swap", "bridge", "liquidity", "vault", "lending",
                           "signed_payment", "payment", "issuance", "spam"]
    assert LANES["swap"] == "tokens were swapped on an exchange"
    assert len(LANES) <= 10  # Laya clamps temperature for 11+ options


def test_question_names_arc():
    assert classify.LANE_QUESTION["instructions"] == "What happened in this Arc transaction?"


def test_probes_are_arc_shapes():
    assert len(PROBES) >= 20
    joined = " ".join(PROBES)
    for word in ("XLM", "trustline", "order book", "memo", "Stellar"):
        assert word not in joined
    assert all(p.startswith("USDC ") for p in PROBES)


def test_classify_sends_shapes_and_caches():
    seen = []

    def handle(request):
        body = json.loads(request.content)
        seen.append(body)
        results = [{"answers": {
            "lane": {"choice": "swap", "probabilities": {"swap": 0.8, "bridge": 0.2}},
            "control": {"noul": 0.1},
        }} for _ in body["states"]]
        return httpx.Response(200, json={"results": results})

    c = Classifier("http://laya")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    out = asyncio.run(c.classify(["s1", "s1", "s2"]))
    assert [o["lane"] for o in out] == ["swap", "swap", "swap"]
    # The runner-up lanes travel with the answer, so the server can overrule a
    # choice the transfer itself rules out without asking the model again.
    assert out[0]["probabilities"] == {"swap": 0.8, "bridge": 0.2}
    assert seen[0]["states"] == ["s1", "s2"]
    asyncio.run(c.classify(["s1"]))
    assert len(seen) == 1  # answered from cache
    assert seen[0]["questions"]["lane"]["criteria"] == LANES


def answering(request):
    body = json.loads(request.content)
    results = [{"answers": {
        name: {"choice": "swap", "probabilities": {"swap": 0.8}} if name == "lane" else {"noul": 0.1}
        for name in body["questions"]
    }} for _ in body["states"]]
    return httpx.Response(200, json={"results": results})


def test_a_failed_call_counts_nothing():
    state = {"up": True}
    c = Classifier("http://laya")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: answering(r) if state["up"] else httpx.Response(503)))
    asyncio.run(c.classify(["s1"]))
    assert c.take_counts() == (1, 0)
    state["up"] = False
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(c.classify(["s1", "s2"]))  # s1 would have been a hit, s2 a miss
    # Nothing was judged, so the next batch's numbers must not include it.
    assert c.take_counts() == (0, 0)


def test_cache_trim_never_evicts_what_the_batch_still_reads(monkeypatch):
    monkeypatch.setattr(classify, "CACHE_MAX", 2)  # one text's lane + control answers
    c = Classifier("http://laya")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(answering))
    asyncio.run(c.classify(["s1"]))
    # s1 is answered from the cache while s2's answers overflow it mid-call.
    out = asyncio.run(c.classify(["s1", "s2"]))
    assert [o["lane"] for o in out] == ["swap", "swap"]
    assert c.take_counts() == (2, 1)
    assert len(c._cache) == 2
