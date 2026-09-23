import asyncio
import contextlib

from fastapi.testclient import TestClient

from conftest import make_item
from radar import server
from radar.server import VOLUME_WINDOW, Radar


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
    """The app with the feed and the model loop replaced, so tests make no network calls."""
    async def idle():
        return None
    monkeypatch.setattr(server.radar, "ingest", idle)
    monkeypatch.setattr(server.radar, "work", idle)
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
        assert client.get("/favicon.svg").status_code == 200
