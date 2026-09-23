"""Arc Radar: every USDC transfer on Arc, typed by a local decision model."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse

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


class Radar:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_MAX)
        self.pool = RpcPool(default_urls())
        self.clients: dict[WebSocket, str | None] = {}
        self.classifier = Classifier(
            os.environ.get("LAYA_ENDPOINT", "http://127.0.0.1:8918"),
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
        self.failures = 0
        self.last_failure = ""
        self.received = 0
        self.classified = 0
        self.dropped = 0
        self.started = time.monotonic()
        self.lane_counts: Counter[str] = Counter()
        self.latencies: deque[float] = deque(maxlen=50)
        self.asked = 0      # transfers the model actually judged
        self.reused = 0     # transfers answered from an earlier identical text
        self.model: dict[str, Any] = {}
        self._volume: deque[tuple[float, str, float]] = deque()

    # ---- fan-out -----------------------------------------------------------
    def rules_by_slot(self) -> dict[str, str]:
        """Pick this batch's questions, oldest-served first.

        Eight fit in the time between batches. Rather than drop the ninth
        asker, the questions take turns: whichever has waited longest goes
        next, so with more questions than slots everyone is answered less
        often and nobody is answered never.
        """
        pending = {slot_name(s): s for s in self.rules.values()}
        for slot in list(self._last_served):
            if slot not in pending:
                del self._last_served[slot]

        order = sorted(pending, key=lambda slot: self._last_served.get(slot, -1.0))
        chosen = order[:MAX_RULES]
        now = time.monotonic()
        for slot in chosen:
            self._last_served[slot] = now
        return {slot: pending[slot] for slot in chosen}

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self.clients:
            return
        dead: list[WebSocket] = []
        for client in list(self.clients):
            try:
                await client.send_json(message)
            except Exception:  # noqa: BLE001 - a dropped viewer must not stop the radar
                dead.append(client)
        for client in dead:
            self.clients.pop(client, None)

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

    def stats(self) -> dict[str, Any]:
        elapsed = max(time.monotonic() - self.started, 1e-6)
        latency = sorted(self.latencies)
        return {
            "received": self.received,
            "classified": self.classified,
            "dropped": self.dropped,
            "in_rate": round(self.received / elapsed, 1),
            "out_rate": round(self.classified / elapsed, 1),
            "queue": self.queue.qsize(),
            "batch_ms": round(latency[len(latency) // 2], 1) if latency else None,
            "asked": self.asked,
            "reused": self.reused,
            "unique_rate": round(self.asked / elapsed, 1),
            "lanes": dict(self.lane_counts),
            "rules": sorted(set(self.rules.values())),
            "model": self.model,
            "failing": self.failures >= 2,
            "failure": self.last_failure if self.failures >= 2 else "",
            "volume": self.volume(),
        }

    # ---- pipeline ----------------------------------------------------------
    async def ingest(self) -> None:
        """Read Arc and hand transfers to the classifier.

        When the model falls behind, the oldest transfer is dropped and
        counted.  A radar that silently skips work is lying about coverage, so
        the number is shown on screen.
        """
        async for item in stream_transfers(self.pool):
            self.received += 1
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
        for item, summary, answer in zip(batch, summaries, answers):
            lane = answer["lane"] if answer["lane"] and answer["lane_p"] >= UNCERTAIN_BELOW else "uncertain"
            self.lane_counts[lane] += 1
            self.classified += 1
            self.record_volume(lane, summary["amount"], item["seen_at"])
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
        return list(collapsed.values())

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

            summaries = [summarize(item) for item in batch]
            asked = dict(self.rules_by_slot())
            started = time.monotonic()
            try:
                answers = await self.classifier.classify(
                    [s["shape"] for s in summaries], asked
                )
            except Exception as exc:  # noqa: BLE001 - keep the radar alive
                LOG.warning("classify failed: %s", exc)
                self.failures += 1
                self.last_failure = str(exc)[:200]
                # No latency sample and no take_counts(): the model was never
                # actually asked, so neither number should pretend it was.
                stand_in = {"lane": "", "lane_p": 0.0, "stuck": False, "rules": {}}
                rows = self._rows(batch, summaries, [stand_in] * len(batch), offline=True)
                await self.broadcast({"type": "ops", "ops": rows, "stats": self.stats()})
                continue
            self.failures = 0
            self.latencies.append((time.monotonic() - started) * 1000)

            asked, reused = self.classifier.take_counts()
            self.asked += asked
            self.reused += reused

            rows = self._rows(batch, summaries, answers, offline=False)
            await self.broadcast({"type": "ops", "ops": rows, "stats": self.stats()})


def slot_name(sentence: str) -> str:
    """Name a question by its text, so the same question is asked once."""
    return "r" + hashlib.sha1(sentence.encode()).hexdigest()[:10]


async def screen(question: str) -> str:
    """Decide whether a question is worth putting to the network.

    Cheap check first: most of what gets rejected is rejected on its wording
    and never reaches the model. What survives is run against the probe set,
    because a question that reads perfectly well can still separate nothing --
    "is the sender a purple elephant?" is a grammatical English question and
    answers every transfer the same way.
    """
    if question in radar.verdicts:
        return radar.verdicts[question]
    verdict = inspect(question)
    if not verdict:
        try:
            verdict = "" if separation(await radar.classifier.probe(question)) >= MIN_SEPARATION else "flat"
        except Exception as exc:  # noqa: BLE001 - never block a question on a hiccup
            LOG.warning("probe failed for %r: %s", question[:60], exc)
            return ""
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


@app.get("/api/lanes")
async def lanes() -> dict[str, str]:
    return LANES


@app.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    await ws.accept()
    radar.clients[ws] = None
    await ws.send_json({"type": "hello", "lanes": LANES, "stats": radar.stats()})
    try:
        while True:
            message = await ws.receive_json()
            if "rule" not in message:
                continue
            rule = (message["rule"] or "").strip()[:200]
            key = str(id(ws))
            radar.rules.pop(key, None)
            if not rule:
                await ws.send_json({"type": "rule", "rule": None, "slot": None, "answered": True})
                continue

            # A question that would sort nothing is turned away here rather
            # than taking a slot from someone whose question works, and the
            # viewer is told which rule it hit instead of watching a column
            # of numbers that all say the same thing.
            verdict = await screen(rule)
            if verdict:
                await ws.send_json({"type": "rule", "rule": None, "slot": None,
                                    "answered": True, "rejected": verdict,
                                    "because": REASONS[verdict], "asked": rule})
                continue

            # Re-inserted last, so the newest question is first in line.
            radar.rules[key] = rule
            slot = slot_name(rule)
            # Only this viewer is told; nobody else's screen changes. If every
            # slot is taken, say so rather than leaving an empty column.
            answered = slot in radar.rules_by_slot()
            await ws.send_json(
                {"type": "rule", "rule": rule, "slot": slot, "answered": answered}
            )
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        LOG.debug("websocket closed: %s", exc)
    finally:
        radar.clients.pop(ws, None)
        radar.rules.pop(str(id(ws)), None)
