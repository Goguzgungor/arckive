import asyncio
import json

import httpx

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
    assert seen[0]["states"] == ["s1", "s2"]
    asyncio.run(c.classify(["s1"]))
    assert len(seen) == 1  # answered from cache
    assert seen[0]["questions"]["lane"]["criteria"] == LANES
