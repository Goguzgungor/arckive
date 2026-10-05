import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "netwatch", Path(__file__).resolve().parent.parent / "scripts" / "netwatch.py")
netwatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(netwatch)

UP = {"tunnel": True}
TUNNEL_DOWN = {"tunnel": False, "model": True, "gate": True, "internet": True}
NETWORK_DOWN = {"tunnel": False, "model": True, "gate": True, "internet": False}
MODEL_DOWN = {"tunnel": False, "model": False, "gate": True, "internet": True}
GATE_DOWN = {"tunnel": False, "model": True, "gate": False, "internet": True}


def run(seen_by_minute, state=None, start=0.0):
    """Feed one observation a minute; return the repairs made and the last state."""
    state, repairs, logs = state or {}, [], []
    for minute, seen in enumerate(seen_by_minute):
        layer, state, log = netwatch.decide(seen, state, start + 60.0 * minute)
        repairs.append(layer)
        logs.extend(log)
    return repairs, state, logs


def test_nothing_is_done_while_the_tunnel_answers():
    repairs, state, logs = run([UP] * 5)
    assert repairs == [""] * 5 and logs == []
    assert state["since"] is None and state["fails"] == {}


def test_the_innermost_broken_layer_is_the_one_repaired():
    assert netwatch.broken_layer(MODEL_DOWN) == "model"
    assert netwatch.broken_layer({**MODEL_DOWN, "gate": False}) == "model"
    assert netwatch.broken_layer(GATE_DOWN) == "gate"
    assert netwatch.broken_layer(NETWORK_DOWN) == "network"
    assert netwatch.broken_layer(TUNNEL_DOWN) == "tunnel"
    assert netwatch.broken_layer(UP) == ""


def test_a_blip_is_not_an_outage():
    # Two bad minutes and then fine: nothing is restarted.
    repairs, _, _ = run([TUNNEL_DOWN, TUNNEL_DOWN, UP])
    assert repairs == ["", "", ""]


def test_a_repair_waits_three_bad_minutes_then_backs_off():
    repairs, state, logs = run([NETWORK_DOWN] * 40)
    acted = [minute for minute, layer in enumerate(repairs) if layer]
    # the third minute, then 10 and 20 minutes after each previous attempt
    assert acted == [2, 12, 32]
    assert all(repairs[m] == "network" for m in acted)
    assert state["cooldown"]["network"] == 2400.0
    # Each wait after a repair is said once, not every minute.
    assert sum("still down" in line for line in logs) == len(acted)


def test_the_cooldown_stops_growing_at_an_hour():
    _, state, _ = run([TUNNEL_DOWN] * 400)
    assert state["cooldown"]["tunnel"] == netwatch.MAX_COOLDOWN


def test_when_the_broken_layer_changes_its_count_starts_over():
    # Wi-Fi comes back but the tunnel stays wedged: the tunnel gets its own
    # three minutes before cloudflared is restarted.
    repairs, _, _ = run([NETWORK_DOWN, NETWORK_DOWN, TUNNEL_DOWN, TUNNEL_DOWN, TUNNEL_DOWN])
    assert repairs == ["", "", "", "", "tunnel"]


def test_recovery_is_logged_and_forgets_the_outage():
    repairs, state, logs = run([MODEL_DOWN] * 4 + [UP])
    assert repairs == ["", "", "model", "", ""]
    assert logs[0].startswith("model not reachable through the tunnel; model is down")
    assert logs[-1] == "model reachable again after 4 min"
    assert state == {"fails": {}, "next": {}, "cooldown": {}, "since": None, "told": ""}


def test_finds_the_wifi_device():
    ports = ("Hardware Port: Ethernet\nDevice: en0\nEthernet Address: d0:11\n\n"
             "Hardware Port: Wi-Fi\nDevice: en1\nEthernet Address: d0:12\n")
    assert netwatch.wifi_in(ports) == "en1"
    assert netwatch.wifi_in("Hardware Port: Ethernet\nDevice: en0\n") == ""


def test_agent_labels_can_come_from_the_environment():
    assert netwatch.agents("model=com.arc-radar.model, gate=com.arc-radar.gate,tunnel=com.stellar-radar.tunnel") == {
        "model": ["com.arc-radar.model"], "gate": ["com.arc-radar.gate"], "tunnel": ["com.stellar-radar.tunnel"]}
    assert netwatch.agents("") == {}


def test_only_allowed_layers_are_repaired(monkeypatch):
    monkeypatch.setattr(netwatch, "REPAIRS", {"model", "gate"})
    assert netwatch.repair("network", dry_run=True).startswith("network is down; left to")
    assert netwatch.repair("tunnel", dry_run=True).startswith("tunnel is down; left to")
