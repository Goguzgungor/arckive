#!/usr/bin/env python3
"""Keep the model reachable through outages, on the Mac that serves it.

    python3 scripts/netwatch.py            # one check; launchd runs it every minute
    python3 scripts/netwatch.py --dry-run  # say what it would do, and do nothing

The radars reach the model through three things on this Mac: layad (the
model), the gate in front of it, and the Cloudflare tunnel that publishes the
gate. launchd restarts any of them that exits, but not one that hangs, and
nothing restarts the network under all three. On 2026-09-29 the Mac's Wi-Fi
was gone from 03:48 to 13:27, and every model call either radar made in those
nine and a half hours came back 530 from Cloudflare.

Each run asks one thing first: does the gate answer through the tunnel? If it
does, nothing else is checked. If not, the innermost broken layer is found and
only that one is repaired -- once it has been broken for FAILS_BEFORE_ACTION
runs in a row, and not again before its cooldown, which doubles each time the
same repair did not help, up to MAX_COOLDOWN:

    model    layad does not answer /health            -> restart the model agent
    gate     the gate does not answer on loopback     -> restart the gate agent
    network  nothing on the internet answers          -> turn Wi-Fi off and on
    tunnel   the internet answers, the tunnel does not -> restart cloudflared

It cannot fix a router or an ISP that is down. Then turning Wi-Fi off and on
does nothing, the cooldown grows, and the log says the network is still down.
Python 3.9 compatible: launchd runs it with the system /usr/bin/python3.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TUNNEL_URL = os.environ.get("NETWATCH_TUNNEL_URL", "https://laya-gate.brages.uk/health")
GATE_URL = os.environ.get("NETWATCH_GATE_URL", "http://127.0.0.1:8919/health")
MODEL_URL = os.environ.get("NETWATCH_MODEL_URL", "http://127.0.0.1:8918/health")
# Two unrelated hosts, so one of them being down is not "the internet is down".
INTERNET_URLS = os.environ.get(
    "NETWATCH_INTERNET_URLS",
    "https://1.1.1.1/cdn-cgi/trace,https://captive.apple.com/hotspot-detect.html",
).split(",")
STATE = Path(os.environ.get(
    "NETWATCH_STATE", "~/Library/Application Support/arc-radar/netwatch.json")).expanduser()

FAILS_BEFORE_ACTION = 3   # runs in a row, a minute apart: a blip is not an outage
FIRST_COOLDOWN = 600.0    # seconds before the same repair is tried again
MAX_COOLDOWN = 3600.0
TIMEOUT = 8.0
# Cloudflare answers requests from Python's default User-Agent with 403 before
# they reach the tunnel; this one gets through to the gate.
USER_AGENT = "arc-radar-netwatch/1.0"

def agents(text: str) -> dict[str, list[str]]:
    """'model=a,gate=b' -> {'model': ['a'], 'gate': ['b']}; '' -> {}."""
    out: dict[str, list[str]] = {}
    for part in text.split(","):
        if "=" in part:
            layer, label = (s.strip() for s in part.split("=", 1))
            out.setdefault(layer, []).append(label)
    return out


# The agents on this Mac may carry either name: the ledger radar installed them
# first, and this repo's templates use its own. Whichever is loaded is the one.
# A second copy of this script watching Arc's own model sets its labels with
# NETWATCH_AGENTS instead (com.arc-radar.netwatch-arc.plist).
LABELS = agents(os.environ.get("NETWATCH_AGENTS", "")) or {
    "model": ["com.stellar-radar.model", "com.arc-radar.model"],
    "gate": ["com.stellar-radar.gate", "com.arc-radar.gate"],
    "tunnel": ["com.stellar-radar.tunnel", "com.arc-radar.tunnel"],
}
LAYERS = ["model", "gate", "network", "tunnel"]
# Which layers this copy may repair. The copy watching Arc's model repairs
# only its model and gate: the network and the tunnel are shared, and two
# watchdogs toggling the same Wi-Fi would undo each other.
REPAIRS = set(filter(None, os.environ.get("NETWATCH_REPAIRS", ",".join(LAYERS)).split(",")))


def answers(url: str, *, ok_below: int = 500) -> bool:
    """Whether `url` answers with a status below `ok_below`.

    The gate answers 401 without its token, and 401 is a perfectly good sign of
    life. Through the tunnel, a missing connector is Cloudflare's 530, so for
    the tunnel only a 5xx or no answer at all counts as down.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status < ok_below
    except urllib.error.HTTPError as exc:
        return exc.code < ok_below
    except Exception:  # noqa: BLE001 - refused, timed out, no route: all "does not answer"
        return False


def observe() -> dict[str, bool]:
    tunnel = answers(TUNNEL_URL)
    if tunnel:
        return {"tunnel": True}
    return {
        "tunnel": False,
        "model": answers(MODEL_URL, ok_below=300),
        "gate": answers(GATE_URL),
        "internet": any(answers(u.strip(), ok_below=400) for u in INTERNET_URLS if u.strip()),
    }


def broken_layer(seen: dict[str, bool]) -> str:
    """The innermost layer that is down, or '' when the tunnel answers."""
    if seen.get("tunnel"):
        return ""
    if not seen.get("model"):
        return "model"
    if not seen.get("gate"):
        return "gate"
    if not seen.get("internet"):
        return "network"
    return "tunnel"


def decide(seen: dict[str, bool], state: dict, now: float) -> tuple[str, dict, list[str]]:
    """What to repair this run: (layer or '', new state, log lines).

    Pure, so the whole policy is testable without touching the machine.
    """
    state = {"fails": dict(state.get("fails", {})), "next": dict(state.get("next", {})),
             "cooldown": dict(state.get("cooldown", {})), "since": state.get("since"),
             "told": state.get("told", "")}
    layer = broken_layer(seen)
    log: list[str] = []
    if not layer:
        if state["since"] is not None:
            log.append(f"model reachable again after {(now - state['since']) / 60:.0f} min")
        return "", {"fails": {}, "next": {}, "cooldown": {}, "since": None, "told": ""}, log

    if state["since"] is None:
        state["since"] = now
        log.append(f"model not reachable through the tunnel; {layer} is down")
    # Only the innermost broken layer counts; the others are not being judged.
    state["fails"] = {layer: state["fails"].get(layer, 0) + 1}
    if state["fails"][layer] < FAILS_BEFORE_ACTION:
        return "", state, log
    if now < state["next"].get(layer, 0.0):
        if state["told"] != layer:
            wait = (state["next"][layer] - now) / 60
            log.append(f"{layer} still down; next repair in {wait:.0f} min")
            state["told"] = layer
        return "", state, log
    cooldown = min(state["cooldown"].get(layer, FIRST_COOLDOWN / 2) * 2, MAX_COOLDOWN)
    state["cooldown"][layer] = cooldown
    state["next"][layer] = now + cooldown
    state["told"] = ""
    return layer, state, log


def _uid() -> int:
    return os.getuid()


def _loaded(label: str) -> bool:
    return subprocess.run(["launchctl", "print", f"gui/{_uid()}/{label}"],
                          capture_output=True).returncode == 0


def wifi_in(ports: str) -> str:
    """The Wi-Fi device named in `networksetup -listallhardwareports` output."""
    lines = [line.strip() for line in ports.splitlines()]
    for i, line in enumerate(lines):
        if line == "Hardware Port: Wi-Fi" and i + 1 < len(lines) and lines[i + 1].startswith("Device:"):
            return lines[i + 1].split(":", 1)[1].strip()
    return ""


def wifi_device() -> str:
    """The Wi-Fi interface, if it exists and is switched on; '' otherwise.

    Wi-Fi someone switched off on purpose is left off.
    """
    ports = subprocess.run(["networksetup", "-listallhardwareports"], capture_output=True, text=True).stdout
    device = wifi_in(ports)
    if not device:
        return ""
    power = subprocess.run(["networksetup", "-getairportpower", device], capture_output=True, text=True).stdout
    return device if power.strip().endswith("On") else ""


def _run(command: list[str]) -> str:
    """Run a repair command; '' if it worked, else why not, for the log."""
    done = subprocess.run(command, capture_output=True, text=True)
    return "" if done.returncode == 0 else f" -- failed: {(done.stderr or done.stdout).strip()[:200]}"


def repair(layer: str, dry_run: bool) -> str:
    """Carry out one repair; returns what was done, for the log."""
    if layer not in REPAIRS:
        return f"{layer} is down; left to the watchdog that owns it"
    if layer == "network":
        device = wifi_device()
        if not device:
            return "network down and Wi-Fi is off or absent; nothing to do from here"
        if dry_run:
            return f"turned Wi-Fi ({device}) off and on"
        failed = _run(["networksetup", "-setairportpower", device, "off"])
        time.sleep(5)
        failed += _run(["networksetup", "-setairportpower", device, "on"])
        return f"turned Wi-Fi ({device}) off and on{failed}"
    label = next((lb for lb in LABELS[layer] if _loaded(lb)), "")
    if not label:
        return f"{layer} is down but no agent for it is loaded ({', '.join(LABELS[layer])})"
    if dry_run:
        return f"restarted {label}"
    return f"restarted {label}" + _run(["launchctl", "kickstart", "-k", f"gui/{_uid()}/{label}"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="report what would be done, change nothing")
    args = parser.parse_args()

    try:
        state = json.loads(STATE.read_text())
    except (OSError, ValueError):
        state = {}
    now = time.time()
    layer, state, log = decide(observe(), state, now)
    if layer:
        done = repair(layer, args.dry_run)
        log.append(("would have " if args.dry_run else "") + done)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    for line in log:
        print(f"{stamp} {line}", flush=True)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state))
    return 0


if __name__ == "__main__":
    sys.exit(main())
