"""A small authenticating gate in front of the decision model.

The model daemon has no authentication and no transport security; it is built
to listen on loopback and stay there.  Publishing it through a tunnel puts it
within reach of everything else running on the far host, so this sits in
between: it speaks only the two routes the radar needs, requires a shared
secret on every call, and caps how much work one request can ask for.

It changes nothing about the Mac's exposure.  The tunnel is dialled outward
from here, so no port is opened on this machine or its router, and this gate
binds to loopback like the model behind it.

    RADAR_TOKEN=$(openssl rand -hex 32) python -m radar.modelgate
"""
from __future__ import annotations

import hmac
import logging
import os
import time
from collections import deque
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
LOG = logging.getLogger("modelgate")

UPSTREAM = os.environ.get("LAYAD_ENDPOINT", "http://127.0.0.1:8918").rstrip("/")
TOKEN = os.environ.get("RADAR_TOKEN", "")
MAX_STATES = int(os.environ.get("RADAR_MAX_STATES", "512"))
# The radar asks one question to sort the stream plus one per viewer, so this
# ceiling has to clear the radar's own cap rather than meet it.
MAX_QUESTIONS = int(os.environ.get("RADAR_MAX_QUESTIONS", "24"))
MAX_CHARS = int(os.environ.get("RADAR_MAX_CHARS", "2000"))
RATE_PER_MIN = int(os.environ.get("RADAR_RATE_PER_MIN", "240"))

if not TOKEN:
    raise SystemExit(
        "RADAR_TOKEN is not set. Refusing to start: without it this gate would "
        "forward anything that reaches it straight to the model.\n"
        "  RADAR_TOKEN=$(openssl rand -hex 32) python -m radar.modelgate"
    )

app = FastAPI(title="Model gate")
client = httpx.AsyncClient(base_url=UPSTREAM, timeout=120.0)
calls: deque[float] = deque()


def authorise(header: str | None) -> None:
    supplied = header[7:] if header and header.startswith("Bearer ") else ""
    # Compared in constant time so a wrong token cannot be found one byte at a time.
    if not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(status_code=401, detail="bad or missing token")


def spend_budget() -> None:
    now = time.monotonic()
    while calls and now - calls[0] > 60:
        calls.popleft()
    if len(calls) >= RATE_PER_MIN:
        raise HTTPException(status_code=429, detail="too many requests")
    calls.append(now)


@app.get("/health")
async def health(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorise(authorization)
    response = await client.get("/health")
    return response.json()


@app.post("/ai/run/batch")
async def batch(request: Request, authorization: str | None = Header(default=None)) -> Any:
    authorise(authorization)
    spend_budget()

    body = await request.json()
    states, questions = body.get("states"), body.get("questions")
    if not isinstance(states, list) or not isinstance(questions, dict):
        raise HTTPException(status_code=400, detail="expected states and questions")
    if len(states) > MAX_STATES:
        raise HTTPException(status_code=413, detail=f"at most {MAX_STATES} states")
    if len(questions) > MAX_QUESTIONS:
        raise HTTPException(status_code=413, detail=f"at most {MAX_QUESTIONS} questions")
    if sum(len(str(s)) for s in states) > MAX_STATES * MAX_CHARS:
        raise HTTPException(status_code=413, detail="states too large")

    # Only these two fields are passed on; anything else the caller sent is dropped.
    response = await client.post("/ai/run/batch", json={"states": states, "questions": questions})
    response.raise_for_status()
    return response.json()


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("RADAR_GATE_HOST", "127.0.0.1")
    port = int(os.environ.get("RADAR_GATE_PORT", "8919"))
    LOG.info("gate on %s:%s -> %s (token required, %s calls/min)", host, port, UPSTREAM, RATE_PER_MIN)
    uvicorn.run(app, host=host, port=port, log_level="warning")
