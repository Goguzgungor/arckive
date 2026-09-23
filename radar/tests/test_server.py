import asyncio
import contextlib
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from conftest import make_item
from radar import server
from radar.gate import REASONS
from radar.server import (
    BREAKER_OPEN, FEED_STALE, HEARTBEAT, MODEL_TIMEOUT, QUESTION_EVERY, VOLUME_WINDOW,
    Pace, ProbeBudget, Radar, Rate, settle_lane, viewer,
)
from radar.types import ZERO
from radar.summarize import summarize


class Clock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


SWAP = {"lane": "swap", "lane_p": 0.9, "stuck": False, "rules": {}}


def test_volume_window():
    r = Radar()
    r.record_volume("swap", 10.0, at=1000.0)
    r.record_volume("swap", 5.5, at=1500.0)
    r.record_volume("bridge", 100.0, at=1590.0)
    assert r.volume(now=1600.0) == {"swap": 15.5, "bridge": 100.0}
    assert r.volume(now=1000.0 + VOLUME_WINDOW + 1) == {"swap": 5.5, "bridge": 100.0}


def test_stats_has_volume():
    r = Radar()
    assert "volume" in r.stats()


def idle_app(monkeypatch):
    """The app with the feed, the model loop and the startup model check
    replaced, so tests make no network calls -- in particular none to a layad
    that may be serving something live on this machine's default port."""
    async def idle():
        return None

    async def health():
        return {}
    monkeypatch.setattr(server.radar, "ingest", idle)
    monkeypatch.setattr(server.radar, "work", idle)
    monkeypatch.setattr(server.radar.classifier, "health", health)
    monkeypatch.setattr(server.radar, "model", {})
    return TestClient(server.app)


def test_api_served(monkeypatch):
    with idle_app(monkeypatch) as client:
        assert list(client.get("/api/lanes").json())[0] == "swap"
        assert "volume" in client.get("/api/stats").json()


def test_work_keeps_rows_flowing_when_model_offline(monkeypatch):
    """A dead model must not blank the screen: rows still land, marked offline.

    Dropping the batch on a classify failure would make an outage look like
    silence -- indistinguishable from no transfers happening at all. Instead
    the batch is shown with a stand-in answer, so the viewer sees the model is
    down without losing the feed.
    """
    async def failing_classify(texts, rules):
        raise RuntimeError("model unreachable")
    monkeypatch.setattr(server.radar.classifier, "classify", failing_classify)

    captured: list[dict] = []
    async def capture(message):
        captured.append(message)
    monkeypatch.setattr(server.radar, "broadcast", capture)

    # BATCH_WAIT would otherwise hold the loop open for a real 1.5s hoping a
    # second transfer arrives; nothing else will, so shrink the wait instead
    # of slowing the test down for no reason.
    monkeypatch.setattr(server, "BATCH_WAIT", 0.05)

    before_failures = server.radar.failures
    server.radar.queue.put_nowait(make_item())

    async def run_one_batch():
        task = asyncio.create_task(server.radar.work())
        for _ in range(200):
            if any(m.get("type") == "ops" for m in captured):
                break
            await asyncio.sleep(0.01)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(asyncio.wait_for(run_one_batch(), timeout=5))

    ops_messages = [m for m in captured if m["type"] == "ops"]
    assert ops_messages, "classify failure must still broadcast an ops message"
    rows = ops_messages[0]["ops"]
    assert rows
    assert all(row["lane"] == "uncertain" for row in rows)
    assert all(row["offline"] is True for row in rows)
    assert server.radar.failures == before_failures + 1


def test_index_is_arc(monkeypatch):
    with idle_app(monkeypatch) as client:
        page = client.get("/")
        assert page.status_code == 200
        assert "<title>Arc Radar</title>" in page.text
        for word in ("Stellar", "XLM", "Horizon", "sorolog"):
            assert word not in page.text
        # Public copy names the model, not the machine it happens to run on.
        assert "judged by Laya" in page.text
        assert "Mac" not in page.text
        assert client.get("/favicon.svg").status_code == 200
        # A page the server dropped as too slow is never told; it has to
        # notice the silence itself and reconnect.
        assert "SILENCE_MS = 20000" in page.text
        # The socket refuses frames over 4 KiB, so the box stops well short.
        assert 'maxlength="200"' in page.text



# ---- one slow viewer ------------------------------------------------------

class FakeViewer:
    def __init__(self, *, stall: bool = False, broken: bool = False) -> None:
        self.stall, self.broken = stall, broken
        self.got: list[tuple[float, dict]] = []

    async def send_text(self, text: str) -> None:
        if self.broken:
            raise RuntimeError("connection reset")
        if self.stall:
            await asyncio.Event().wait()  # a socket whose buffer never drains
        self.got.append((time.monotonic(), json.loads(text)))


def test_a_stalled_viewer_does_not_hold_up_the_others(monkeypatch):
    monkeypatch.setattr(server, "SEND_TIMEOUT", 0.2)
    r = Radar()
    stalled, broken, healthy = FakeViewer(stall=True), FakeViewer(broken=True), FakeViewer()
    for v in (stalled, broken, healthy):
        r.clients[v] = None
    r.rules[viewer(stalled)] = "is this a large swap?"

    async def go():
        start = time.monotonic()
        await r.broadcast({"type": "ops", "ops": []})
        took = time.monotonic() - start
        await r.broadcast({"type": "ops", "ops": [1]})
        return start, took

    start, took = asyncio.run(go())
    # Delivered at once, not after the stalled viewer ahead of it gave up.
    assert healthy.got[0][0] - start < 0.2
    # The whole fan-out costs at most one timeout, once.
    assert took < 0.2 + 0.15
    assert [m for _, m in healthy.got] == [{"type": "ops", "ops": []}, {"type": "ops", "ops": [1]}]
    assert list(r.clients) == [healthy]
    assert r.rules == {}


# ---- the feed -------------------------------------------------------------

def test_ingest_restarts_a_feed_that_raises_or_ends(monkeypatch):
    starts = []

    async def feed(pool):
        starts.append(pool)
        if len(starts) == 1:
            raise RuntimeError("boom")
        if len(starts) == 2:
            return
        yield make_item()
        await asyncio.Event().wait()

    monkeypatch.setattr(server, "stream_transfers", feed)
    monkeypatch.setattr(server, "FEED_RESTART", 0)
    r = Radar()

    async def go():
        task = asyncio.create_task(r.ingest())
        for _ in range(200):
            if r.received:
                break
            await asyncio.sleep(0.005)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(asyncio.wait_for(go(), timeout=5))
    assert len(starts) == 3
    assert r.received == 1 and r.last_transfer_at is not None


def test_feed_liveness_has_a_grace_period_then_goes_stale():
    clock = Clock()
    r = Radar(clock=clock)
    clock.now += FEED_STALE
    assert r.feed_alive()          # still starting up
    clock.now += 1
    assert not r.feed_alive()      # nothing has ever arrived
    r.receive(make_item())
    assert r.feed_alive() and r.stats()["feed_age_s"] == 0.0
    clock.now += FEED_STALE + 1
    assert not r.feed_alive()
    assert r.stats()["feed_age_s"] == FEED_STALE + 1


def test_healthz_is_503_when_the_feed_is_stale(monkeypatch):
    with idle_app(monkeypatch) as client:
        now = server.radar.clock()
        monkeypatch.setattr(server.radar, "started", now - FEED_STALE - 5)
        monkeypatch.setattr(server.radar, "last_transfer_at", None)
        assert client.get("/healthz").status_code == 503
        monkeypatch.setattr(server.radar, "last_transfer_at", now)
        ok = client.get("/healthz")
        assert ok.status_code == 200 and ok.json()["feed"] == "ok"


# ---- the model --------------------------------------------------------------

def test_model_timeout_is_short():
    assert Radar().classifier._client.timeout.read == MODEL_TIMEOUT


def test_breaker_rests_the_model_after_two_failures():
    clock = Clock()
    r = Radar(clock=clock)
    calls = []

    async def dead(texts, rules):
        calls.append(texts)
        raise httpx.ConnectError("All connection attempts failed: http://10.9.8.7:8919")
    r.classifier.classify = dead

    async def batches(n):
        return [await r.process([make_item()]) for _ in range(n)]

    rows = asyncio.run(batches(4))
    assert len(calls) == 2  # batches three and four never waited on the model
    assert all(row["offline"] for batch in rows for row in batch)
    assert r.failures == 4 and not r.latencies
    clock.now += BREAKER_OPEN
    asyncio.run(batches(1))
    assert len(calls) == 3  # the rest is over, so the model is asked again


@pytest.mark.parametrize("exc, shown", [
    (httpx.ConnectError("All connection attempts failed: http://10.9.8.7:8919"), "model unreachable"),
    (httpx.ReadTimeout("timed out talking to http://10.9.8.7:8919"), "model unreachable"),
    (KeyError("results from http://10.9.8.7:8919"), "model error"),
])
def test_the_wall_gets_a_generic_failure_never_the_endpoint(exc, shown):
    r = Radar()

    async def dead(texts, rules):
        raise exc
    r.classifier.classify = dead

    async def twice():
        for _ in range(2):
            await r.process([make_item()])

    asyncio.run(twice())
    stats = r.stats()
    assert stats["failing"] and stats["failure"] == shown
    assert "10.9.8.7" not in json.dumps(stats)


def test_model_name_is_learned_after_a_success_when_startup_missed_it():
    r = Radar()
    assert r.model == {}

    async def classify(texts, rules):
        return [SWAP] * len(texts)

    async def health():
        return {"model": "laya", "backend": "mlx"}
    r.classifier.classify = classify
    r.classifier.health = health

    async def go():
        await r.process([make_item()])
        await r._identity

    asyncio.run(go())
    assert r.model == {"model": "laya", "backend": "mlx"}


# ---- rows, lanes and gauges -----------------------------------------------

def test_volume_counts_each_transaction_once_per_lane_at_its_largest_leg():
    r = Radar()
    legs = [make_item(value=10_000_000, log_index=1), make_item(value=25_000_000, log_index=2),
            make_item(value=7_000_000, log_index=5)]
    bridge = {**SWAP, "lane": "bridge"}
    r._rows(legs, [summarize(i) for i in legs], [SWAP, SWAP, bridge], offline=False)
    assert r.volume(now=legs[0]["seen_at"]) == {"swap": 25.0, "bridge": 7.0}


def test_a_lane_outside_the_choice_set_is_uncertain():
    r = Radar()
    item = make_item()
    rows = r._rows([item], [summarize(item)], [{**SWAP, "lane": "rugpull", "lane_p": 0.99}], offline=False)
    assert rows[0]["lane"] == "uncertain"
    assert r.lane_counts == {"uncertain": 1}
    assert set(r.volume(now=item["seen_at"])) == {"uncertain"}


WALLET_A = "0x" + "11" * 20
WALLET_B = "0x" + "22" * 20
LEANING_MINT = {"lane": "issuance", "lane_p": 0.45,
                "probabilities": {"issuance": 0.45, "swap": 0.40, "bridge": 0.15}}


def test_mint_lane_needs_the_zero_address():
    # Nothing was minted or burned unless one side is the zero address; the
    # model's runner-up takes the row instead.
    assert settle_lane(LEANING_MINT, WALLET_A, WALLET_B) == ("swap", 0.40)
    assert settle_lane(LEANING_MINT, ZERO, WALLET_B) == ("issuance", 0.45)
    assert settle_lane(LEANING_MINT, WALLET_A, ZERO) == ("issuance", 0.45)


def test_a_weak_runner_up_leaves_a_non_mint_uncertain():
    weak = {"lane": "issuance", "lane_p": 0.7,
            "probabilities": {"issuance": 0.7, "swap": 0.2, "bridge": 0.1}}
    assert settle_lane(weak, WALLET_A, WALLET_B) == ("uncertain", 0.2)
    # An answer with nothing to fall back on cannot be overruled into a lane.
    assert settle_lane({"lane": "issuance", "lane_p": 0.9}, WALLET_A, WALLET_B)[0] == "uncertain"


def test_rows_keep_non_mints_out_of_the_mint_lane():
    r = Radar()
    item = make_item(frm=WALLET_A, to=WALLET_B)
    rows = r._rows([item], [summarize(item)], [{**SWAP, **LEANING_MINT}], offline=False)
    assert rows[0]["lane"] == "swap"
    assert rows[0]["lane_p"] == 0.40
    assert r.lane_counts == {"swap": 1}


def test_heartbeat_speaks_only_into_silence():
    # With no transfers arriving the wall would say nothing, and a page that
    # hears nothing cannot tell a quiet chain from a dead socket.
    clock = Clock()
    r = Radar(clock=clock)
    sent = []

    async def capture(message):
        sent.append(message["type"])
        r.last_sent = clock()

    r.broadcast = capture
    r.last_sent = clock()
    clock.now += HEARTBEAT - 0.1
    asyncio.run(r.beat())
    assert sent == []
    clock.now += 0.2
    asyncio.run(r.beat())
    assert sent == ["stats"]
    asyncio.run(r.beat())
    assert sent == ["stats"]


def test_broadcast_marks_when_the_wall_last_spoke():
    clock = Clock()
    r = Radar(clock=clock)
    r.clients[object()] = None

    async def ok(client, text):
        return True

    r._send = ok
    clock.now += 42
    asyncio.run(r.broadcast({"type": "stats"}))
    assert r.last_sent == clock.now


def test_rate_is_a_sliding_window():
    rate = Rate(window=60.0)
    for t in range(60):
        rate.add(1, float(t))
    assert rate.per_second(60.0, since=0.0) == 1.0
    assert rate.per_second(90.0, since=0.0) == 0.5
    assert rate.per_second(200.0, since=0.0) == 0.0
    # Before a full window has passed, the rate is over the uptime so far.
    early = Rate()
    early.add(10, 1001.0)
    assert early.per_second(1002.0, since=1000.0) == 5.0


def test_gauges_describe_the_last_minute_not_the_lifetime():
    clock = Clock()
    r = Radar(clock=clock)
    clock.now += 0.5
    for _ in range(60):
        r.receive(make_item())
    clock.now += 29.5
    assert r.stats()["in_rate"] == 2.0
    clock.now += 70  # a lifetime average would still say 0.6
    assert r.stats()["in_rate"] == 0.0


# ---- viewer questions -----------------------------------------------------

def test_pace_allows_one_new_question_every_few_seconds():
    clock = Clock()
    pace = Pace(every=3.0, clock=clock)
    assert pace.wait() == 0
    pace.spend()
    clock.now += 1.0
    assert pace.wait() == 2.0
    clock.now += 2.0
    assert pace.wait() == 0


def test_probe_budget_is_shared_and_rolls_over():
    clock = Clock()
    budget = ProbeBudget(limit=20, window=60.0, clock=clock)
    assert all(budget.take() for _ in range(20))
    assert not budget.take()
    clock.now += 59.9
    assert not budget.take()
    clock.now += 0.1
    assert budget.take()


@pytest.fixture
def gate(monkeypatch):
    """The module's radar with an empty verdict cache, a fresh budget on a
    fake clock and a stub model that separates everything it is asked."""
    clock = Clock()
    probed = []

    async def probe(question):
        probed.append(question)
        return [1.0] * 12 + [0.0] * 12
    monkeypatch.setattr(server.radar, "verdicts", {})
    monkeypatch.setattr(server.radar, "budget", ProbeBudget(clock=clock))
    monkeypatch.setattr(server.radar, "rules", {})
    monkeypatch.setattr(server.radar, "_last_served", {})
    monkeypatch.setattr(server.radar, "_model_rests_until", 0.0)
    monkeypatch.setattr(server.radar.classifier, "probe", probe)
    return clock, probed


def test_screen_paces_new_questions_per_viewer(gate):
    clock, probed = gate
    pace = Pace(clock=clock)

    async def go():
        first = await server.screen("is this a large swap?", pace)
        second = await server.screen("is this a bridge deposit?", pace)
        known = await server.screen("is this a large swap?", pace)   # already judged: free
        worded = await server.screen("hello", pace)                  # refused on wording: free
        clock.now += QUESTION_EVERY
        third = await server.screen("is this a bridge deposit?", pace)
        return first, second, known, worded, third

    assert asyncio.run(go()) == ("", "slow", "", "short", "")
    assert probed == ["is this a large swap?", "is this a bridge deposit?"]


def test_screen_turns_questions_away_once_the_budget_is_spent(gate, monkeypatch):
    clock, _ = gate
    monkeypatch.setattr(server.radar, "budget", ProbeBudget(limit=1, clock=clock))

    async def go():
        return (await server.screen("is this a large swap?", Pace(clock=clock)),
                await server.screen("is this a bridge deposit?", Pace(clock=clock)))

    assert asyncio.run(go()) == ("", "busy")
    assert "is this a bridge deposit?" not in server.radar.verdicts  # busy is not a verdict


def test_screen_refuses_a_question_it_could_not_check(gate, monkeypatch):
    clock, _ = gate

    async def broken(question):
        raise httpx.ReadTimeout("model hung")
    monkeypatch.setattr(server.radar.classifier, "probe", broken)
    assert asyncio.run(server.screen("is this a large swap?", Pace(clock=clock))) == "busy"
    assert server.radar.verdicts == {}


def test_screen_does_not_probe_a_resting_model(gate, monkeypatch):
    clock, probed = gate
    monkeypatch.setattr(server.radar, "_model_rests_until", server.radar.clock() + 100)
    assert asyncio.run(server.screen("is this a large swap?", Pace(clock=clock))) == "busy"
    assert probed == []


def test_websocket_paces_questions_and_keeps_them_private(gate, monkeypatch):
    with idle_app(monkeypatch) as client, client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json({"rule": "is this a large swap?"})
        accepted = ws.receive_json()
        stats = client.get("/api/stats").json()
        served = dict(server.radar._last_served)
        ws.send_json({"rule": "is this a bridge deposit?"})
        refused = ws.receive_json()

    assert accepted["rule"] == "is this a large swap?" and accepted["answered"] is True
    # Telling the viewer it will be answered did not use up its turn.
    assert served == {}
    # Everyone sees how many questions are being asked, nobody sees which.
    assert stats["questions"] == 1 and "rules" not in stats
    assert "is this a large swap?" not in json.dumps(stats)
    assert refused["rejected"] == "slow" and refused["because"] == REASONS["slow"]
    assert 0 < refused["retry_in"] <= QUESTION_EVERY
