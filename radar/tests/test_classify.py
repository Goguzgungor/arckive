import asyncio
import json

import httpx
import pytest

from radar import classify
from radar.classify import LANES, Classifier
from radar.gate import PROBES


def test_the_model_chooses_between_eight_lanes():
    # Order is part of the question (moving spam first cost 14 points), and
    # mint / burn is decided by the transfer, never offered to the model.
    assert list(LANES) == ["swap", "bridge", "liquidity", "vault", "lending",
                           "signed_payment", "payment", "spam"]
    assert "even if tokens were also swapped" in LANES["bridge"]
    assert len(LANES) <= 10  # Laya clamps temperature for 11+ options


def test_question_names_arc():
    assert classify.LANE_QUESTION["instructions"] == "What kind of Arc transaction is this?"


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
    # Nobody asked anything, so nothing but the lane was put to the model.
    assert set(seen[0]["questions"]) == {"lane"}
    assert out[0]["stuck"] is False and out[0]["rules"] == {}


def test_lanes_read_the_shape_and_questions_read_the_story():
    seen = []

    def handle(request):
        body = json.loads(request.content)
        seen.append(body)
        return answering(request)

    c = Classifier("http://laya")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    out = asyncio.run(c.classify(["shape"], ["story"], {"r1": "is this a swap?"}))
    lane_call, rule_call = seen
    assert lane_call["states"] == ["shape"] and set(lane_call["questions"]) == {"lane"}
    assert rule_call["states"] == ["story"] and set(rule_call["questions"]) == {"control", "r1"}
    assert rule_call["questions"]["r1"]["instructions"] == "About this Arc USDC transfer: is this a swap?"
    assert out[0]["rules"] == {"r1": 0.1}
    # A new question puts the story to the model again, never the lane: that
    # answer is cached, and it is the same whatever anyone asks.
    asyncio.run(c.classify(["shape"], ["story"], {"r1": "is this a swap?", "r2": "is this a bridge?"}))
    assert [set(b["questions"]) for b in seen[2:]] == [{"control", "r1", "r2"}]


def test_probe_asks_the_story_probes_with_the_prefix():
    seen = []

    def handle(request):
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(200, json={"results": [{"answers": {"probe": {"noul": 0.5}}} for _ in body["states"]]})

    c = Classifier("http://laya")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    scores = asyncio.run(c.probe("is this a swap?"))
    assert len(scores) == len(PROBES)
    assert seen[0]["states"] == PROBES
    assert seen[0]["questions"]["probe"]["instructions"] == "About this Arc USDC transfer: is this a swap?"


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
    monkeypatch.setattr(classify, "CACHE_MAX", 1)  # one text's lane answer
    c = Classifier("http://laya")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(answering))
    asyncio.run(c.classify(["s1"]))
    # s1 is answered from the cache while s2's answers overflow it mid-call.
    out = asyncio.run(c.classify(["s1", "s2"]))
    assert [o["lane"] for o in out] == ["swap", "swap"]
    assert c.take_counts() == (2, 1)
    assert len(c._cache) == 1
