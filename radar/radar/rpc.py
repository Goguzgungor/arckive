"""A small pool of Arc RPC endpoints, tried in the order they are configured.

Order is priority, not load balancing: the official endpoint answers fastest
but rate-limits bursts (HTTP 429 seen during design), so it is used until it
refuses and then rested while the others carry the load.  A lagging node also
answers `null` for a transaction it has not seen yet, so a batch can re-ask
just those entries somewhere else instead of treating the whole call as failed.
"""
from __future__ import annotations

import itertools
import logging
import os
import time
from collections.abc import Callable
from typing import Any

import httpx

LOG = logging.getLogger("radar.rpc")

DEFAULT_URLS = [
    "https://rpc.mainnet.arc.io",
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://rpc.beamrpc.com",
]


def default_urls() -> list[str]:
    raw = os.environ.get("ARC_RPCS", "")
    urls = [u.strip() for u in raw.split(",") if u.strip()]
    return urls or list(DEFAULT_URLS)


class RpcError(Exception):
    """Every endpoint refused or failed the call."""


class _Endpoint:
    def __init__(self, url: str) -> None:
        self.url = url
        self.failures = 0
        self.until = 0.0


class RpcPool:
    def __init__(
        self,
        urls: list[str],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0,
        cooldown_start: float = 5.0,
        cooldown_max: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        chunk: int = 20,
    ) -> None:
        if not urls:
            raise ValueError("RpcPool needs at least one endpoint")
        self._endpoints = [_Endpoint(u.rstrip("/")) for u in urls]
        self._client = httpx.AsyncClient(
            timeout=timeout, transport=transport,
            headers={"User-Agent": "arc-radar/1.0", "Content-Type": "application/json"},
        )
        self._start = cooldown_start
        self._max = cooldown_max
        self._clock = clock
        self._chunk = chunk
        self._ids = itertools.count(1)

    async def close(self) -> None:
        await self._client.aclose()

    def cooling_until(self, url: str) -> float:
        for ep in self._endpoints:
            if ep.url == url.rstrip("/"):
                return ep.until
        raise KeyError(url)

    def _order(self) -> list[_Endpoint]:
        """Available endpoints in priority order; if none, all of them, soonest first.

        Raising while every endpoint is resting would stall the feed for up to
        a minute over what is usually a one-second blip, so the resting ones
        are tried anyway, the one closest to recovering first.
        """
        now = self._clock()
        ready = [ep for ep in self._endpoints if ep.until <= now]
        return ready or sorted(self._endpoints, key=lambda ep: ep.until)

    def _rest(self, ep: _Endpoint, why: str) -> None:
        ep.failures += 1
        wait = min(self._start * 2 ** (ep.failures - 1), self._max)
        ep.until = self._clock() + wait
        LOG.warning("rpc %s %s, resting %.0fs", ep.url, why, wait)

    def _healthy(self, ep: _Endpoint) -> None:
        ep.failures = 0
        ep.until = 0.0

    async def _post(self, ep: _Endpoint, payload: Any) -> Any | None:
        """POST to one endpoint; None when the endpoint itself failed."""
        try:
            response = await self._client.post(ep.url, json=payload)
        except httpx.HTTPError as exc:
            self._rest(ep, type(exc).__name__)
            return None
        if response.status_code == 429 or response.status_code >= 500:
            self._rest(ep, f"HTTP {response.status_code}")
            return None
        if response.status_code != 200:
            self._rest(ep, f"HTTP {response.status_code}")
            return None
        try:
            body = response.json()
        except ValueError:
            self._rest(ep, "non-JSON body")
            return None
        self._healthy(ep)
        return body

    async def call(self, method: str, params: list[Any]) -> Any:
        last = "no endpoint answered"
        for ep in self._order():
            body = await self._post(ep, {"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": params})
            if body is None:
                last = f"{ep.url} failed"
                continue
            if "error" in body:
                # A JSON-RPC error is an answer, not an outage: the endpoint is
                # up but will not serve this request (range limits differ per
                # provider), so try the next one without resting this one.
                last = f"{ep.url}: {body['error'].get('message', body['error'])}"
                continue
            return body.get("result")
        raise RpcError(f"{method}: {last}")

    async def batch(self, calls: list[tuple[str, list[Any]]], *, retry_null: bool = False) -> list[Any]:
        results: list[Any] = [None] * len(calls)
        for start in range(0, len(calls), self._chunk):
            idx = list(range(start, min(start + self._chunk, len(calls))))
            await self._batch_chunk(calls, idx, results, retry_null)
        return results

    async def _batch_chunk(self, calls, idx: list[int], results: list[Any], retry_null: bool) -> None:
        pending = idx
        tried: set[str] = set()
        for ep in self._order() + [e for e in self._endpoints]:
            if not pending or ep.url in tried:
                continue
            tried.add(ep.url)
            ids = {next(self._ids): i for i in pending}
            payload = [{"jsonrpc": "2.0", "id": rid, "method": calls[i][0], "params": calls[i][1]} for rid, i in ids.items()]
            body = await self._post(ep, payload)
            if not isinstance(body, list):
                continue
            answered = set()
            for item in body:
                i = ids.get(item.get("id"))
                if i is None or "error" in item:
                    continue
                results[i] = item.get("result")
                if results[i] is not None or not retry_null:
                    answered.add(i)
            pending = [i for i in pending if i not in answered]
            if not retry_null and not pending:
                return
