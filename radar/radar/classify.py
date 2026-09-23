"""Client for the local decision model behind layad.

One batch call answers every question for every transfer in a single forward
pass, which is the property the radar is built on.  A hosted model would bill
per transfer and could not run on every keystroke.
"""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from typing import Any

import httpx

from .gate import PROBES

# Nine lanes, each described in the exact words summarize.py uses for the fact
# that defines it.  Measured on 384 live Arc transfers: eleven lanes described
# abstractly ("USDC traded for another token on a DEX") agreed with the rule
# labels 4-50% of the time; these nine, reusing the summary's own phrases,
# agreed 89%.  Laya also clamps its temperature for 11 or more options, which
# leaves the choice uncalibrated, so the set stays at ten or fewer.
LANES = {
    "swap": "tokens were swapped on an exchange",
    "bridge": "funds were sent across chains through a bridge",
    "liquidity": "pool liquidity changed",
    "vault": "tokens were deposited into or withdrawn from a contract",
    "lending": "a loan was opened, repaid or liquidated",
    "signed_payment": "the payer signed an authorization and someone else submitted it",
    "payment": "a plain direct transfer from one wallet to another",
    "issuance": "USDC was minted or burned",
    "spam": "a transfer of less than one cent with nothing else happening",
}

LANE_QUESTION = {
    "type": "choice",
    "instructions": "What happened in this Arc transaction?",
    "criteria": LANES,
}

# A question nothing can honestly answer yes to, asked of every operation on
# every batch.  Some states saturate: measured over 400 live operations, ten
# of them answered 1.00 to seven mutually exclusive questions at once -- the
# same dust payment was a trade, a contract call, a new account and a
# trustline, all certainly.  Those ten sat at the top of every viewer's
# results and were the loudest thing wrong with the answers.
#
# They cannot be spotted from one answer, only from answering something absurd
# the same way.  Of six candidates this one was the cleanest: it caught 7 of
# the 10 saturated states and fired on none of the other 390.
CONTROL_QUESTION = {"type": "noul", "instructions": "does this operation sing?"}
CONTROL_FIRES = 0.5


CACHE_MAX = 60_000


def _key(spec: dict[str, Any]) -> str:
    """A stable name for one question, so its answers can be cached apart."""
    return hashlib.sha1(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]


class Classifier:
    """Classifies transfer shapes, remembering answers per exact text.

    Real network traffic is dominated by campaigns that repeat one transfer
    shape thousands of times, so most of a batch is text the model has already
    judged.  Caching cuts the work by roughly the repetition factor and, just
    as importantly, makes the radar self-consistent: two transfers that read
    identically can no longer land in two different lanes.
    """

    def __init__(
        self,
        endpoint: str = "http://127.0.0.1:8918",
        timeout: float = 120.0,
        token: str = "",
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        # Cloudflare sits in front of the tunnel and refuses some clients by
        # their default User-Agent: a request identifying as Python-urllib is
        # answered with 403 before it reaches the gate, whatever it carries.
        # httpx's default passes today, which is not a thing to depend on.
        headers = {"User-Agent": "arc-radar/1.0"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.AsyncClient(timeout=timeout, headers=headers)
        self._cache: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
        self.hits = 0
        self.misses = 0

    async def close(self) -> None:
        await self._client.aclose()

    async def health(self) -> dict[str, Any]:
        response = await self._client.get(f"{self._endpoint}/health")
        response.raise_for_status()
        return response.json()

    async def classify(
        self, texts: list[str], rules: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        """Classify a batch, plus one yes/no question per active viewer question.

        The model answers every question in one forward pass, so a second
        viewer asking something costs one more question on the same call, not
        a second call.

        Answers are cached per question rather than per batch, so someone
        typing a new question misses only on their own. The lane the stream is
        sorted by stays answered, and the machine does not re-read the whole
        network because one person got curious.
        """
        rules = rules or {}
        questions: dict[str, Any] = {"lane": LANE_QUESTION, "control": CONTROL_QUESTION}
        for name, rule in rules.items():
            questions[name] = {"type": "noul", "instructions": rule}

        keys = {name: _key(spec) for name, spec in questions.items()}
        unseen: list[str] = []
        for text in texts:
            if all((text, keys[name]) in self._cache for name in questions):
                self.hits += 1
            elif text not in unseen:
                unseen.append(text)

        if unseen:
            self.misses += len(unseen)
            response = await self._client.post(
                f"{self._endpoint}/ai/run/batch",
                json={"states": unseen, "questions": questions},
            )
            response.raise_for_status()
            for text, item in zip(unseen, response.json()["results"]):
                for name, answer in item["answers"].items():
                    self._cache[(text, keys[name])] = answer

        while len(self._cache) > CACHE_MAX:
            self._cache.popitem(last=False)

        out = []
        for text in texts:
            lane = self._cache[(text, keys["lane"])]
            probabilities = lane.get("probabilities", {})
            control = self._cache[(text, keys["control"])]["noul"]
            stuck = control >= CONTROL_FIRES
            out.append({
                "lane": lane.get("choice", ""),
                "lane_p": round(max(probabilities.values()) if probabilities else 0.0, 3),
                # A state that answers the control question yes answers
                # everything yes. Its readings are dropped rather than shown,
                # because a confident wrong answer costs more than a gap.
                "stuck": stuck,
                "rules": {} if stuck else {
                    name: round(self._cache[(text, keys[name])]["noul"], 3) for name in rules
                },
            })
            for name in questions:
                self._cache.move_to_end((text, keys[name]))
        return out

    async def probe(self, question: str) -> list[float]:
        """Ask one candidate question of the fixed probe set.

        Used by the gate, which needs to know what a question does before it
        is let near the stream. One call, one forward pass, ~800ms, and the
        answer is cached by the caller, so it happens once per new question.
        """
        response = await self._client.post(
            f"{self._endpoint}/ai/run/batch",
            json={"states": PROBES, "questions": {"probe": {"type": "noul", "instructions": question}}},
        )
        response.raise_for_status()
        return [item["answers"]["probe"]["noul"] for item in response.json()["results"]]

    def take_counts(self) -> tuple[int, int]:
        """Return (asked, reused) since the last call, then reset."""
        asked, reused = self.misses, self.hits
        self.misses = self.hits = 0
        return asked, reused
