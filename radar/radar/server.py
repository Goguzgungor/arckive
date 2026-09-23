"""Arc Radar: every USDC transfer on Arc, typed by a local decision model."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import math
import os
import time
from collections import Counter, deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from .arc import stream_transfers
from .classify import LANES, Classifier
from .gate import MIN_SEPARATION, REASONS, inspect, separation
from .rpc import RpcPool, default_urls
from .summarize import summarize

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
LOG = logging.getLogger("radar")

# The model is shared with another live radar on the same GPU: a cold-cache
# batch of 400 long Arc sentences held it for ~13s and made that radar drop
# work. Arc's steady state is ~10-15 transfers per BATCH_WAIT window, so 64
# only splits the rare startup burst -- it costs nothing in the steady state
# and stops one radar from starving the other.
BATCH_MAX = 64          # transfers per model call
BATCH_WAIT = 1.5        # seconds to gather a batch before sending it
QUEUE_MAX = 2000        # bounded so a slow model cannot grow memory without bound
UNCERTAIN_BELOW = 0.35  # below this the lane is shown as uncertain, not guessed
MAX_RULES = 8           # questions answered per batch; each adds ~70ms
VOLUME_WINDOW = 600.0   # seconds of USDC volume shown per lane
# The gauges say "per second", so they describe the last minute rather than
# the whole uptime: a lifetime average hides a stall behind hours of healthy
# traffic and takes hours to show a surge.
RATE_WINDOW = 60.0

# A viewer whose socket stops draining -- a backgrounded tab on a bad link, or
# someone doing it on purpose -- must not hold the wall up for everyone else.
# Sends go out concurrently and a viewer that cannot take one within this long
# is dropped; a page that was only slow reconnects by itself.
SEND_TIMEOUT = 2.0

# The model sits behind a tunnel on another machine. When it hangs rather than
# refuses, the client's default two minutes froze the wall for two minutes;
# twenty seconds is still several times a cold 64-transfer batch.
MODEL_TIMEOUT = 20.0
# After this many failures in a row the model is left alone for BREAKER_OPEN
# seconds and batches go straight to the wall, marked offline: asking a dead
# model again every batch only makes every batch wait out the timeout.
BREAKER_AFTER = 2
BREAKER_OPEN = 15.0
# If the model was down at startup, the footer cannot name it. Ask again after
# a batch succeeds, at most this often while the answer keeps failing.
IDENTITY_EVERY = 60.0

# The feed is the one thing the wall cannot do without. If it ever stops it is
# restarted after FEED_RESTART seconds, and if no transfer arrives for
# FEED_STALE seconds anyway -- Arc carries several a second -- /healthz says
# so, so the container can be replaced instead of showing a frozen wall.
FEED_RESTART = 2.0
FEED_STALE = 120.0

# Viewer questions run on the same model, and the GPU under it also serves
# another live app. Checking a new question costs a forward pass over the probe
# set (~800 ms), so one viewer gets a new question checked at most every
# QUESTION_EVERY seconds, everyone together PROBE_BUDGET per PROBE_WINDOW, and
# probes run one at a time. Questions already judged, or refused on their
# wording, cost nothing and are never slowed.
QUESTION_EVERY = 3.0
PROBE_BUDGET = 20
PROBE_WINDOW = 60.0

WEB = Path(__file__).resolve().parent.parent / "web"

# The radar answers on one address; anything else named here is sent to it.
# Only the hosts listed are redirected, so a health check arriving by IP or by
# container name still reaches the app rather than bouncing off a 301.
CANONICAL_HOST = os.environ.get("RADAR_CANONICAL_HOST", "")
REDIRECT_FROM = {
    h.strip().lower()
    for h in os.environ.get("RADAR_REDIRECT_FROM", "").split(",")
    if h.strip()
}


class Rate:
    """Events per second over the last RATE_WINDOW seconds.

    Counted in one-second buckets, so it holds a minute of integers however
    busy Arc gets.
    """

    def __init__(self, window: float = RATE_WINDOW) -> None:
        self._window = window
        self._buckets: deque[list[int]] = deque()  # [second, count]

    def add(self, n: int, now: float) -> None:
        second = int(now)
        if self._buckets and self._buckets[-1][0] == second:
            self._buckets[-1][1] += n
        else:
            self._buckets.append([second, n])
        self._trim(now)

    def _trim(self, now: float) -> None:
        while self._buckets and self._buckets[0][0] < now - self._window:
            self._buckets.popleft()

    def per_second(self, now: float, since: float) -> float:
        """The rate over the window, or over the uptime while that is shorter.

        Never over less than one second, the width of a bucket: a viewer
        connecting in the first instant would otherwise see one transfer
        reported as hundreds a second.
        """
        self._trim(now)
        span = min(self._window, max(now - since, 1.0))
        return sum(count for _, count in self._buckets) / span


class Pace:
    """One viewer's allowance of new questions to check: one per QUESTION_EVERY."""

    def __init__(self, every: float = QUESTION_EVERY, clock: Callable[[], float] = time.monotonic) -> None:
        self._every = every
        self._clock = clock
        self._last: float | None = None

    def wait(self) -> float:
        """Seconds until this viewer's next new question may be checked; 0 if now."""
        if self._last is None:
            return 0.0
        return max(0.0, self._last + self._every - self._clock())

    def spend(self) -> None:
        self._last = self._clock()


class ProbeBudget:
    """Question checks allowed across all viewers per rolling PROBE_WINDOW."""

    def __init__(self, limit: int = PROBE_BUDGET, window: float = PROBE_WINDOW,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._limit = limit
        self._window = window
        self._clock = clock
        self._spent: deque[float] = deque()

    def take(self) -> bool:
        now = self._clock()
        while self._spent and self._spent[0] <= now - self._window:
            self._spent.popleft()
        if len(self._spent) >= self._limit:
            return False
        self._spent.append(now)
        return True


def viewer(ws: Any) -> str:
    """The key a viewer's question is filed under."""
    return str(id(ws))


class Radar:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_MAX)
        self.pool = RpcPool(default_urls())
        self.clients: dict[WebSocket, str | None] = {}
        self.classifier = Classifier(
            os.environ.get("LAYA_ENDPOINT", "http://127.0.0.1:8918"),
            timeout=MODEL_TIMEOUT,
            token=os.environ.get("RADAR_TOKEN", ""),
        )
        # One question per viewer rather than one for everybody: a stranger
        # typing a question used to change what every other viewer was looking
        # at. Identical sentences share a slot, so two people asking the same
        # thing cost one question, not two.
        self.rules: dict[str, str] = {}
        self._last_served: dict[str, float] = {}
        # What the gate decided about each question it has seen. A verdict is
        # a property of the sentence, not of who typed it, so the second
        # person to ask something is answered from here instead of spending a
        # forward pass on it.
        self.verdicts: dict[str, str] = {}
        self.budget = ProbeBudget(clock=clock)
        self.probing = asyncio.Semaphore(1)
        self.failures = 0
        self.last_failure = ""
        self._model_rests_until = 0.0
        self.received = 0
        self.classified = 0
        self.dropped = 0
        self.started = clock()
        self.last_transfer_at: float | None = None
        self.rate_in = Rate()
        self.rate_out = Rate()
        self.rate_asked = Rate()
        self.lane_counts: Counter[str] = Counter()
        self.latencies: deque[float] = deque(maxlen=50)
        self.asked = 0      # transfers the model actually judged
        self.reused = 0     # transfers answered from an earlier identical text
        self.model: dict[str, Any] = {}
        self._identity: asyncio.Task[None] | None = None
        self._identity_at = -math.inf
        self._volume: deque[tuple[float, str, float]] = deque()

    # ---- fan-out -----------------------------------------------------------
    def next_slots(self) -> dict[str, str]:
        """The questions the next batch would carry, without taking their turn."""
        pending = {slot_name(s): s for s in self.rules.values()}
        order = sorted(pending, key=lambda slot: self._last_served.get(slot, -1.0))
        return {slot: pending[slot] for slot in order[:MAX_RULES]}

    def rules_by_slot(self) -> dict[str, str]:
        """Pick this batch's questions, oldest-served first.

        Eight fit in the time between batches. Rather than drop the ninth
        asker, the questions take turns: whichever has waited longest goes
        next, so with more questions than slots everyone is answered less
        often and nobody is answered never.
        """
        live = {slot_name(s) for s in self.rules.values()}
        for slot in list(self._last_served):
            if slot not in live:
                del self._last_served[slot]

        chosen = self.next_slots()
        now = self.clock()
        for slot in chosen:
            self._last_served[slot] = now
        return chosen

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Send one message to every viewer at once.

        Encoded once and sent concurrently, each send bounded by SEND_TIMEOUT.
        Sent one after another, a single socket with a full buffer held every
        viewer after it -- and the batch loop behind them -- for as long as it
        stayed full. A viewer that times out or errors is dropped, and not
        closed here: a close is one more frame into the same full buffer.
        """
        if not self.clients:
            return
        text = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        clients = list(self.clients)
        delivered = await asyncio.gather(*(self._send(client, text) for client in clients))
        for client, ok in zip(clients, delivered):
            if not ok:
                self.drop(client)

    @staticmethod
    async def _send(client: WebSocket, text: str) -> bool:
        try:
            await asyncio.wait_for(client.send_text(text), SEND_TIMEOUT)
        except Exception:  # noqa: BLE001 - a dropped viewer must not stop the radar
            return False
        return True

    def drop(self, client: WebSocket) -> None:
        """Forget a viewer, and the question it was holding a slot with."""
        self.clients.pop(client, None)
        self.rules.pop(viewer(client), None)

    def record_volume(self, lane: str, amount: float, at: float) -> None:
        self._volume.append((at, lane, amount))

    def volume(self, now: float | None = None) -> dict[str, float]:
        """USDC per lane over the last ten minutes: where the money is going now."""
        now = time.time() if now is None else now
        while self._volume and self._volume[0][0] < now - VOLUME_WINDOW:
            self._volume.popleft()
        out: dict[str, float] = {}
        for _, lane, amount in self._volume:
            out[lane] = out.get(lane, 0.0) + amount
        return {lane: round(v, 2) for lane, v in out.items()}

    def feed_age(self, now: float | None = None) -> float | None:
        """Seconds since the feed last delivered a transfer; None before the first."""
        if self.last_transfer_at is None:
            return None
        now = self.clock() if now is None else now
        return round(now - self.last_transfer_at, 1)

    def feed_alive(self, now: float | None = None) -> bool:
        """False once no transfer has arrived for FEED_STALE seconds.

        Measured from startup until the first transfer, so the first
        FEED_STALE seconds are always alive: the feed starts at the head and
        may not have met a block with USDC in it yet.
        """
        now = self.clock() if now is None else now
        last = self.started if self.last_transfer_at is None else self.last_transfer_at
        return now - last <= FEED_STALE

    def stats(self) -> dict[str, Any]:
        now = self.clock()
        latency = sorted(self.latencies)
        # One failure is a blip; the page raises its warning at the same point
        # the breaker stops asking the model.
        failing = self.failures >= BREAKER_AFTER
        return {
            "received": self.received,
            "classified": self.classified,
            "dropped": self.dropped,
            "in_rate": round(self.rate_in.per_second(now, self.started), 1),
            "out_rate": round(self.rate_out.per_second(now, self.started), 1),
            "queue": self.queue.qsize(),
            "batch_ms": round(latency[len(latency) // 2], 1) if latency else None,
            "asked": self.asked,
            "reused": self.reused,
            "unique_rate": round(self.rate_asked.per_second(now, self.started), 1),
            "lanes": dict(self.lane_counts),
            # How many distinct questions are being asked, never what they
            # are: a viewer's question is shown to nobody but that viewer.
            "questions": len(set(self.rules.values())),
            "model": self.model,
            "failing": failing,
            "failure": self.last_failure if failing else "",
            "volume": self.volume(),
            "feed_age_s": self.feed_age(now),
        }

    # ---- pipeline ----------------------------------------------------------
    async def ingest(self) -> None:
        """Read Arc and hand transfers to the classifier, for as long as the app runs.

        When the model falls behind, the oldest transfer is dropped and
        counted.  A radar that silently skips work is lying about coverage, so
        the number is published as `dropped` in /api/stats.

        The feed is built never to end, but it is supervised anyway: if it
        ever returns or raises, it is logged and started again, rather than
        leaving the wall frozen on its last row with nothing in the logs.
        """
        while True:
            try:
                async for item in stream_transfers(self.pool):
                    self.receive(item)
                LOG.error("feed ended; restarting in %.0fs", FEED_RESTART)
            except Exception:  # noqa: BLE001 - the wall is nothing without the feed
                LOG.exception("feed crashed; restarting in %.0fs", FEED_RESTART)
            await asyncio.sleep(FEED_RESTART)

    def receive(self, item: dict[str, Any]) -> None:
        now = self.clock()
        self.received += 1
        self.last_transfer_at = now
        self.rate_in.add(1, now)
        try:
            self.queue.put_nowait(item)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
                self.dropped += 1
            with contextlib.suppress(asyncio.QueueFull):
                self.queue.put_nowait(item)

    def _rows(
        self, batch: list[dict[str, Any]], summaries: list[Any], answers: list[dict[str, Any]],
        *, offline: bool,
    ) -> list[dict[str, Any]]:
        """Turn one batch of transfers into broadcast rows, tallying as it goes.

        Shared by the healthy path and the model-unreachable path below: a
        batch the model could not judge still deserves rows on screen -- marked
        offline rather than dropped -- so an outage looks like an outage, not
        like nothing happened on Arc for a while. Campaigns repeat one transfer
        shape thousands of times, so identical shapes (protocol + shape) arrive
        as a single row carrying how many times the shape occurred.
        """
        collapsed: dict[str, dict[str, Any]] = {}
        # A swap moves USDC into and out of the same transaction, so adding up
        # every leg counted the same money two or three times over. Each
        # transaction counts once per lane, at its largest leg.
        largest: dict[tuple[str, str], tuple[float, float]] = {}
        for item, summary, answer in zip(batch, summaries, answers):
            lane = answer["lane"]
            # A lane outside the choice set has no chip on the page and no
            # place in the tallies; it is as good as no answer.
            if lane not in LANES or answer["lane_p"] < UNCERTAIN_BELOW:
                lane = "uncertain"
            self.lane_counts[lane] += 1
            self.classified += 1
            leg = (summary["tx"], lane)
            if leg not in largest or summary["amount"] > largest[leg][0]:
                largest[leg] = (summary["amount"], item["seen_at"])
            existing = collapsed.get(summary["family"])
            if existing:
                existing["count"] += 1
                continue
            collapsed[summary["family"]] = {
                "id": summary["id"],
                "text": summary["text"],
                "shape": summary["shape"],
                "family": summary["family"],
                "protocol": summary["protocol"],
                "facts": summary["facts"],
                "amount": summary["amount"],
                "frm": summary["frm"],
                "to": summary["to"],
                "url": summary["url"],
                "lane": lane,
                "lane_p": answer["lane_p"],
                "stuck": answer.get("stuck", False),
                "rules": answer["rules"],
                "at": item["seen_at"],
                "count": 1,
                "offline": offline,
            }
        for (_, lane), (amount, at) in largest.items():
            self.record_volume(lane, amount, at)
        self.rate_out.add(len(batch), self.clock())
        return list(collapsed.values())

    def _offline(self, batch: list[dict[str, Any]], summaries: list[Any]) -> list[dict[str, Any]]:
        # No latency sample and no take_counts(): the model was never
        # actually asked, so neither number should pretend it was.
        stand_in = {"lane": "", "lane_p": 0.0, "stuck": False, "rules": {}}
        return self._rows(batch, summaries, [stand_in] * len(batch), offline=True)

    def _model_failed(self, exc: Exception) -> None:
        # The details go to the log. The wall is public, so it gets a short
        # generic reason -- never the endpoint, nor exception text that
        # might carry it.
        LOG.warning("classify failed: %s: %s", type(exc).__name__, exc)
        self.failures += 1
        self.last_failure = "model unreachable" if isinstance(exc, httpx.TransportError) else "model error"
        if self.failures >= BREAKER_AFTER:
            self._model_rests_until = self.clock() + BREAKER_OPEN

    def model_resting(self) -> bool:
        """Whether the breaker is keeping calls away from a model that just failed."""
        return self.clock() < self._model_rests_until

    def _learn_model(self) -> None:
        """Fetch the model's name if startup could not.

        The footer names the model and the device it runs on. If the model was
        down when the radar started, that read "connecting..." until the next
        restart. A batch that just succeeded shows it is back, so ask then --
        in the background, so rows never wait on it.
        """
        now = self.clock()
        if self.model or now - self._identity_at < IDENTITY_EVERY:
            return
        self._identity_at = now
        self._identity = asyncio.create_task(self._fetch_identity())

    async def _fetch_identity(self) -> None:
        try:
            identity = await self.classifier.health()
            if isinstance(identity, dict):
                self.model = identity
        except Exception as exc:  # noqa: BLE001 - the footer can wait for the next try
            LOG.warning("model identity unavailable: %s", type(exc).__name__)

    async def process(self, batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Judge one batch and turn it into rows, whatever state the model is in."""
        summaries = [summarize(item) for item in batch]
        if self.model_resting():
            # The model failed twice in a row moments ago. Show the batch now,
            # marked offline, rather than make it wait out another timeout.
            self.failures += 1
            return self._offline(batch, summaries)
        asked = self.rules_by_slot()
        started = time.monotonic()
        try:
            answers = await self.classifier.classify([s["shape"] for s in summaries], asked)
        except Exception as exc:  # noqa: BLE001 - keep the radar alive
            self._model_failed(exc)
            return self._offline(batch, summaries)
        self.failures = 0
        self.latencies.append((time.monotonic() - started) * 1000)

        judged, reused = self.classifier.take_counts()
        self.asked += judged
        self.reused += reused
        self.rate_asked.add(judged, self.clock())
        self._learn_model()
        return self._rows(batch, summaries, answers, offline=False)

    async def work(self) -> None:
        while True:
            batch = [await self.queue.get()]
            deadline = time.monotonic() + BATCH_WAIT
            while len(batch) < BATCH_MAX:
                # Take everything already queued without one event-loop round
                # trip per item; awaiting each one costs more than the model.
                try:
                    while len(batch) < BATCH_MAX:
                        batch.append(self.queue.get_nowait())
                except asyncio.QueueEmpty:
                    pass
                if len(batch) >= BATCH_MAX:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    batch.append(await asyncio.wait_for(self.queue.get(), timeout=remaining))
                except asyncio.TimeoutError:
                    break

            try:
                rows = await self.process(batch)
                await self.broadcast({"type": "ops", "ops": rows, "stats": self.stats()})
            except Exception:  # noqa: BLE001 - one bad batch must not end the loop
                # Like the feed, this loop is the wall: an exception escaping
                # it would end the task and freeze every screen, silently.
                LOG.exception("batch of %d transfers lost", len(batch))


def slot_name(sentence: str) -> str:
    """Name a question by its text, so the same question is asked once."""
    return "r" + hashlib.sha1(sentence.encode()).hexdigest()[:10]


async def screen(question: str, pace: Pace) -> str:
    """Decide whether a question is worth putting to the network.

    Cheap check first: most of what gets rejected is rejected on its wording
    and never reaches the model. What survives is run against the probe set,
    because a question that reads perfectly well can still separate nothing --
    "is the sender a purple elephant?" is a grammatical English question and
    answers every transfer the same way.

    That run is a forward pass on a shared GPU, so it is paced per viewer
    ("slow") and budgeted for everyone ("busy"). Neither refusal is
    remembered as the question's verdict: it is about the moment, not the
    sentence.
    """
    if question in radar.verdicts:
        return radar.verdicts[question]
    verdict = inspect(question)
    if not verdict:
        if radar.model_resting():
            # The model just failed twice in a row; a check now would wait
            # out the timeout, holding the probe lock, only to fail.
            return "busy"
        if pace.wait() > 0:
            return "slow"
        if not radar.budget.take():
            return "busy"
        pace.spend()
        try:
            async with radar.probing:
                scores = await radar.classifier.probe(question)
            verdict = "" if separation(scores) >= MIN_SEPARATION else "flat"
        except Exception as exc:  # noqa: BLE001 - a failed check is not a pass
            # Letting the question through unchecked would put an unscreened
            # sentence to the model on every batch; asking again later costs
            # the viewer one retry.
            LOG.warning("probe failed for %r: %s: %s", question[:60], type(exc).__name__, exc)
            return "busy"
    radar.verdicts[question] = verdict
    if len(radar.verdicts) > 4000:
        radar.verdicts.pop(next(iter(radar.verdicts)))
    return verdict


radar = Radar()


async def _lifespan(app: FastAPI):  # noqa: ANN202 - FastAPI lifespan signature
    try:
        radar.model = await radar.classifier.health()
        LOG.info("model ready: %s on %s", radar.model.get("model"), radar.model.get("backend"))
    except Exception as exc:  # noqa: BLE001
        LOG.error(
            "decision model not reachable at %s (%s). Start it with `layad serve`, "
            "or point LAYA_ENDPOINT at the machine that runs it.",
            os.environ.get("LAYA_ENDPOINT", "http://127.0.0.1:8918"), exc,
        )
    tasks = [asyncio.create_task(radar.ingest()), asyncio.create_task(radar.work())]
    yield
    for task in tasks:
        task.cancel()
    await radar.classifier.close()
    await radar.pool.close()


app = FastAPI(title="Arc Radar", lifespan=_lifespan)


@app.middleware("http")
async def canonical_host(request: Request, call_next):  # noqa: ANN001, ANN201
    """Move an old address to the current one, keeping the path and query.

    Permanent, because it is: the link is being retired, not load-balanced.
    Browsers cache a 301 hard, which is the point -- and the reason the pair
    of hosts is configuration rather than something compiled in.
    """
    host = (request.headers.get("host") or "").split(":")[0].lower()
    if CANONICAL_HOST and host in REDIRECT_FROM and host != CANONICAL_HOST:
        target = request.url.replace(scheme="https", netloc=CANONICAL_HOST)
        return RedirectResponse(str(target), status_code=301)
    return await call_next(request)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


@app.get("/favicon.svg")
async def favicon() -> FileResponse:
    return FileResponse(WEB / "favicon.svg")


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
    return radar.stats()


@app.get("/healthz")
async def healthz() -> JSONResponse:
    """Liveness for the container: 503 once the feed has gone quiet.

    /api/stats answers whether or not anything is flowing, so a healthcheck
    pointed at it kept a radar whose feed had died marked healthy for good.
    """
    alive = radar.feed_alive()
    return JSONResponse(
        {"feed": "ok" if alive else "stale", "feed_age_s": radar.feed_age()},
        status_code=200 if alive else 503,
    )


@app.get("/api/lanes")
async def lanes() -> dict[str, str]:
    return LANES


@app.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    await ws.accept()
    radar.clients[ws] = None
    key = viewer(ws)
    pace = Pace(clock=radar.clock)
    try:
        await ws.send_json({"type": "hello", "lanes": LANES, "stats": radar.stats()})
        while True:
            message = await ws.receive_json()
            if ws not in radar.clients:
                # broadcast() dropped this viewer for not keeping up. Taking
                # its questions would give it a slot whose answers it never
                # receives.
                break
            if not isinstance(message, dict) or "rule" not in message:
                continue
            rule = message["rule"] if isinstance(message["rule"], str) else ""
            rule = rule.strip()[:200]
            radar.rules.pop(key, None)
            if not rule:
                await ws.send_json({"type": "rule", "rule": None, "slot": None, "answered": True})
                continue

            # A question that would sort nothing is turned away here rather
            # than taking a slot from someone whose question works, and the
            # viewer is told which rule it hit instead of watching a column
            # of numbers that all say the same thing.
            verdict = await screen(rule, pace)
            if verdict:
                reply = {"type": "rule", "rule": None, "slot": None, "answered": True,
                         "rejected": verdict, "because": REASONS[verdict], "asked": rule}
                if verdict == "slow":
                    # The page asks again by itself once the wait is over, so
                    # someone who types in bursts still gets the last thing
                    # they typed asked.
                    reply["retry_in"] = round(pace.wait(), 2)
                await ws.send_json(reply)
                continue
            if ws not in radar.clients:
                break

            # Re-inserted last, so the newest question is first in line.
            radar.rules[key] = rule
            slot = slot_name(rule)
            # Only this viewer is told; nobody else's screen changes. If every
            # slot is taken, say so rather than leaving an empty column. Only
            # a look at the rotation: taking a turn here would push this
            # question to the back before any batch had answered it.
            answered = slot in radar.next_slots()
            await ws.send_json(
                {"type": "rule", "rule": rule, "slot": slot, "answered": answered}
            )
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        LOG.debug("websocket closed: %s", exc)
    finally:
        radar.drop(ws)
