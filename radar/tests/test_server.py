from fastapi.testclient import TestClient

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
