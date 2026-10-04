"""Run the trainer without starving the radars that share this Mac's GPU.

    .venv/bin/python -m finetune.supervise --log "$RUN/train.log" -- \\
        .venv-ft/bin/python -m finetune.train --data "$DATA/rows" --out "$RUN"

Both radars ask the shared layad (127.0.0.1:8918) all day, and PyTorch on MPS
competes for the same GPU. There is no GPU priority to lower, so this pauses
the trainer instead: it reads the shared model's p95 latency (layad keeps it
over its last 512 requests) every few seconds, stops the trainer with SIGSTOP
the moment p95 is over budget, and continues it with SIGCONT once p95 has
stayed under budget for RESUME_AFTER seconds. The budget is twice the p95
measured before training starts, never under FLOOR_MS.

A model that does not answer counts as over budget: it is restarting, and a
cold model is the worst time to compete with it. On any exit -- Ctrl-C, or
SIGTERM/SIGHUP when the shell that started it goes away -- the trainer is
continued before it is terminated (and killed if it will not go), so a stopped
process never outlives this one holding GPU memory. A stopped process answers
only SIGCONT and SIGKILL, so it would not see the hangup itself. Only SIGKILL
of this supervisor cannot be cleaned up; then continue the trainer by hand:

    pkill -CONT -f finetune.train && pkill -f finetune.train

layad's p95 is over its last 512 requests, so after a pause the figure stays
high until that window has turned over: expect pauses of a minute or more,
not RESUME_AFTER.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import statistics
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

HEALTH = "http://127.0.0.1:8918/health"
FLOOR_MS = 120.0
CHECK_EVERY = 5.0
RESUME_AFTER = 30.0
BASELINE_SAMPLES = 24      # two minutes at CHECK_EVERY


def budget(baseline_p95: float) -> float:
    return max(2 * baseline_p95, FLOOR_MS)


@dataclass
class Pacer:
    paused: bool = False
    calm_since: Optional[float] = None

    def step(self, p95: Optional[float], limit: float, now: float) -> str:
        if p95 is None or p95 > limit:
            self.calm_since = None
            if not self.paused:
                self.paused = True
                return "pause"
            return ""
        if not self.paused:
            return ""
        if self.calm_since is None:
            self.calm_since = now
            return ""
        if now - self.calm_since >= RESUME_AFTER:
            self.paused, self.calm_since = False, None
            return "resume"
        return ""


def exit_on_hangup() -> None:
    """Make SIGTERM and SIGHUP unwind like Ctrl-C, so supervise()'s cleanup runs.

    Python's default for both is to die on the spot, skipping every finally.
    """
    def leave(signum: int, _frame) -> None:
        raise SystemExit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, leave)


def p95_from(url: str) -> Callable[[], Optional[float]]:
    def read() -> Optional[float]:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return json.load(response)["latency_ms"]["p95"]
        except Exception:  # noqa: BLE001 - refused, timed out, restarting: all "not answering"
            return None
    return read


def supervise(cmd: list[str], *, read_p95: Callable[[], Optional[float]], log: Callable[[str], None],
              sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
              spawn=subprocess.Popen, signal_child: Callable[[int, int], None] = os.kill,
              baseline_samples: int = BASELINE_SAMPLES, stdout=None) -> int:
    samples = []
    for _ in range(baseline_samples):
        value = read_p95()
        if value is not None:
            samples.append(value)
        sleep(CHECK_EVERY)
    baseline = statistics.median(samples) if samples else FLOOR_MS / 2
    limit = budget(baseline)
    log(f"baseline p95 {baseline:.1f} ms; pausing above {limit:.1f} ms")

    child = spawn(cmd, stdout=stdout, stderr=subprocess.STDOUT)
    pacer, started, paused_at, paused_total = Pacer(), clock(), None, 0.0
    try:
        while child.poll() is None:
            now = clock()
            p95 = read_p95()
            action = pacer.step(p95, limit, now)
            if action == "pause":
                signal_child(child.pid, signal.SIGSTOP)
                paused_at = now
                log(f"paused: shared model p95 {p95} ms")
            elif action == "resume":
                signal_child(child.pid, signal.SIGCONT)
                paused_total += now - (paused_at if paused_at is not None else now)
                paused_at = None
                log(f"resumed after {paused_total:.0f} s paused in total")
            sleep(CHECK_EVERY)
    finally:
        if child.poll() is None:
            signal_child(child.pid, signal.SIGCONT)
            child.terminate()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=30)
    elapsed = clock() - started
    if paused_at is not None:
        paused_total += clock() - paused_at
    log(f"trainer exited {child.returncode}; {elapsed:.0f} s, {paused_total:.0f} s paused")
    return child.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--health", default=HEALTH)
    parser.add_argument("--log", default="", help="the trainer's output goes here; supervision lines go to stdout")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    cmd = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not cmd:
        parser.error("give the trainer command after --")
    out = open(args.log, "a", buffering=1) if args.log else None

    def log(line: str) -> None:
        print(f"{time.strftime('%H:%M:%S')} {line}", flush=True)

    exit_on_hangup()
    return supervise(cmd, read_p95=p95_from(args.health), log=log, stdout=out)


if __name__ == "__main__":
    sys.exit(main())
