import signal

import pytest

from finetune import supervise as sv


def test_budget_is_twice_the_baseline_with_a_floor():
    assert sv.budget(30.0) == sv.FLOOR_MS
    assert sv.budget(80.0) == 160.0


def test_pauses_at_once_and_resumes_only_after_calm():
    p = sv.Pacer()
    assert p.step(50.0, 120.0, 0.0) == ""
    assert p.step(300.0, 120.0, 5.0) == "pause"
    assert p.step(300.0, 120.0, 10.0) == ""
    assert p.step(60.0, 120.0, 15.0) == ""                       # calm starts
    assert p.step(60.0, 120.0, 15.0 + sv.RESUME_AFTER - 1) == ""
    assert p.step(60.0, 120.0, 15.0 + sv.RESUME_AFTER) == "resume"


def test_a_spike_while_paused_restarts_the_calm_clock():
    p = sv.Pacer()
    p.step(300.0, 120.0, 0.0)
    p.step(60.0, 120.0, 5.0)
    p.step(300.0, 120.0, 20.0)
    assert p.step(60.0, 120.0, 25.0) == ""
    assert p.step(60.0, 120.0, 25.0 + sv.RESUME_AFTER) == "resume"


def test_an_unreachable_model_counts_as_over_budget():
    p = sv.Pacer()
    assert p.step(None, 120.0, 0.0) == "pause"


class FakeChild:
    def __init__(self, polls_until_exit):
        self.pid = 4242
        self.left = polls_until_exit
        self.returncode = None
        self.terminated = False

    def poll(self):
        if self.left <= 0:
            self.returncode = 0
            return 0
        self.left -= 1
        return None

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def wait(self, timeout=None):
        return self.returncode


def _run(p95s, child, sleep=lambda s: None):
    sent = []
    readings = iter(p95s)
    t = [0.0]

    def clock():
        t[0] += sv.CHECK_EVERY
        return t[0]

    code = sv.supervise(["train"], read_p95=lambda: next(readings, 50.0), log=lambda line: None,
                        sleep=sleep, clock=clock, spawn=lambda cmd, **kw: child,
                        signal_child=lambda pid, sig: sent.append(sig), baseline_samples=2)
    return code, sent


def test_stops_and_continues_the_trainer_with_the_model_load():
    child = FakeChild(polls_until_exit=12)
    calm = [50.0] * (int(sv.RESUME_AFTER / sv.CHECK_EVERY) + 2)
    code, sent = _run([40.0, 40.0, 500.0, 500.0] + calm, child)
    assert code == 0
    assert sent == [signal.SIGSTOP, signal.SIGCONT]


def test_an_interrupted_supervisor_never_leaves_the_trainer_stopped():
    child = FakeChild(polls_until_exit=100)
    sent = []
    calls = {"n": 0}

    def sleep(_):
        calls["n"] += 1
        if calls["n"] == 5:
            raise KeyboardInterrupt

    readings = iter([40.0, 40.0, 500.0, 500.0, 500.0, 500.0])
    with pytest.raises(KeyboardInterrupt):
        sv.supervise(["train"], read_p95=lambda: next(readings, 500.0), log=lambda line: None, sleep=sleep,
                     clock=lambda: 0.0, spawn=lambda cmd, **kw: child,
                     signal_child=lambda pid, sig: sent.append(sig), baseline_samples=2)
    assert sent[0] == signal.SIGSTOP and sent[-1] == signal.SIGCONT
    assert child.terminated


def test_sigterm_and_sighup_unwind_so_the_trainer_is_continued():
    import os

    saved = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGHUP)}
    try:
        sv.exit_on_hangup()
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with pytest.raises(SystemExit):
                os.kill(os.getpid(), sig)
    finally:
        for s, h in saved.items():
            signal.signal(s, h)


class StubbornChild(FakeChild):
    def __init__(self):
        super().__init__(polls_until_exit=100)
        self.killed = False

    def wait(self, timeout=None):
        import subprocess
        if not self.killed:
            raise subprocess.TimeoutExpired("train", timeout)
        return -9

    def kill(self):
        self.killed = True


def test_a_trainer_that_ignores_terminate_is_killed():
    child = StubbornChild()

    def sleep(_):
        raise SystemExit(143)

    with pytest.raises(SystemExit):
        sv.supervise(["train"], read_p95=lambda: 40.0, log=lambda line: None, sleep=sleep, clock=lambda: 0.0,
                     spawn=lambda cmd, **kw: child, signal_child=lambda pid, sig: None, baseline_samples=0)
    assert child.terminated and child.killed
