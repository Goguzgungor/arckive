"""Client for the local decision model behind layad.

A batch call answers every question for every transfer in a few milliseconds
each, on a GPU the radar does not pay per call for, which is the property the
radar is built on.  A hosted model would bill per transfer and could not run
on every keystroke.
"""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from typing import Any

import httpx

from .gate import PROBES

# The lanes the model chooses between, each described in the words the lane
# sentence uses for the fact that defines it, with the tie-break for mixed
# transactions spelled out ("even if tokens were also swapped"): a swap that
# ends in a bridge deposit is a bridge transfer. Measured on 16,172 USDC
# movements from ten minutes of mainnet, against lanes read off what each
# transaction actually did: 99.9% agreement, 0.1% below UNCERTAIN_BELOW, the
# right lane at 0.83 on average. The set this replaced scored 78.9%, with
# 15.8% of rows uncertain.
#
# What moved it, each measured on its own:
#   * "What kind of Arc transaction is this?" over "What happened in this Arc
#     transaction?" -- the same answers, held with more confidence.
#   * Mint and burn are not offered. The option, however worded, took
#     probability from every lane (93.5% with it); the transfer itself
#     decides it (see summarize.ruled_lane).
#   * Spam is offered but never decided by the model: it picked it at 0.02
#     for exact matches, yet removing the option cost 1.3 points of agreement
#     and 0.12 of confidence elsewhere. It stays last, as a sink.
#   * The order is part of the question: moving spam first cost 14 points.
#
# Laya also clamps its temperature for 11 or more options, which leaves the
# choice uncalibrated, so the set stays at ten or fewer.
LANES = {
    "swap": "tokens were swapped on an exchange or traded on a marketplace",
    "bridge": "funds were sent to or arrived from another chain through a bridge, even if tokens were also swapped",
    "liquidity": "pool liquidity changed, even if tokens were also swapped",
    "vault": "funds were deposited into or withdrawn from a vault, or USDC was wrapped or unwrapped",
    "lending": "a loan was opened, repaid or liquidated",
    "signed_payment": "the payer signed an authorization and someone else submitted it",
    "payment": "a plain direct transfer, with nothing else happening",
    "spam": "zero or less than one cent of USDC moved and nothing else recognisable happened",
}

LANE_QUESTION = {
    "type": "choice",
    "instructions": "What kind of Arc transaction is this?",
    "criteria": LANES,
}

# Put in front of every viewer question. The model reads a question about
# "this" against a sentence that never says what it is; told, it separated
# transfers better: over 24 test questions on the same story sentences, the
# average AUC went from 0.879 to 0.915.
RULE_PREFIX = "About this Arc USDC transfer: "


def rule_question(text: str) -> dict[str, Any]:
    return {"type": "noul", "instructions": RULE_PREFIX + text}


# A question nothing can honestly answer yes to, asked alongside viewers'
# questions.  Some states saturate: on the ledger radar this model also
# serves, ten of 400 live operations answered 1.00 to seven mutually exclusive
# questions at once, and sat at the top of every viewer's results.  They cannot
# be spotted from one answer, only from answering something absurd the same
# way; of six candidates this one was the cleanest (7 of the 10 caught, none of
# the other 390).  On Arc's sentences it has not fired yet -- 0 of ~16,000 --
# but viewers' questions are free text, and it only costs anything while one
# is being asked.
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
        self, shapes: list[str], stories: list[str] | None = None, rules: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        """The lane of every transfer, and one answer per viewer question.

        Two sentences, two calls. The lane is asked of `shapes`, the questions
        of `stories` (see summarize.py); the second call is made only while
        somebody is asking something. Laya reads every question of a state as
        its own sequence anyway, so splitting them costs a round trip, not
        forward passes.

        Answers are cached per sentence and question, so someone typing a new
        question misses only on their own. The lane the stream is sorted by
        stays answered, and the machine does not re-read the whole network
        because one person got curious.
        """
        rules = rules or {}
        stories = stories if stories is not None else shapes
        lane_key = _key(LANE_QUESTION)
        asked: dict[str, Any] = {}
        if rules:
            asked["control"] = CONTROL_QUESTION
            for name, rule in rules.items():
                asked[name] = rule_question(rule)
        keys = {name: _key(spec) for name, spec in asked.items()}

        unseen_shapes = [s for s in dict.fromkeys(shapes) if (s, lane_key) not in self._cache]
        unseen_stories = [s for s in dict.fromkeys(stories)
                          if any((s, keys[name]) not in self._cache for name in asked)]
        hits = sum(
            1 for shape, story in zip(shapes, stories)
            if shape not in unseen_shapes and story not in unseen_stories
        )

        if unseen_shapes:
            await self._ask(unseen_shapes, {"lane": LANE_QUESTION}, {"lane": lane_key})
        if unseen_stories:
            await self._ask(unseen_stories, asked, keys)

        out = []
        for shape, story in zip(shapes, stories):
            lane = self._cache[(shape, lane_key)]
            probabilities = lane.get("probabilities", {})
            stuck = bool(asked) and self._cache[(story, keys["control"])]["noul"] >= CONTROL_FIRES
            out.append({
                "lane": lane.get("choice", ""),
                "lane_p": round(max(probabilities.values()) if probabilities else 0.0, 3),
                # Kept whole so the server can fall back to the runner-up when
                # the transfer itself rules the choice out (see settle_lane).
                "probabilities": dict(probabilities),
                # A state that answers the control question yes answers
                # everything yes. Its readings are dropped rather than shown,
                # because a confident wrong answer costs more than a gap.
                "stuck": stuck,
                "rules": {} if stuck else {
                    name: round(self._cache[(story, keys[name])]["noul"], 3) for name in rules
                },
            })
            self._cache.move_to_end((shape, lane_key))
            for name in asked:
                self._cache.move_to_end((story, keys[name]))

        # Trimmed only now, after this batch has been read and its entries
        # marked recent: trimming right after the insert could evict an entry
        # this very batch still had to read.
        while len(self._cache) > CACHE_MAX:
            self._cache.popitem(last=False)
        # Counted only for a call that returned answers. A failed call asked
        # the model nothing, and the next take_counts() must not say it did.
        self.hits += hits
        self.misses += len(unseen_shapes) + len(unseen_stories)
        return out

    async def _ask(self, states: list[str], questions: dict[str, Any], keys: dict[str, str]) -> None:
        response = await self._client.post(
            f"{self._endpoint}/ai/run/batch", json={"states": states, "questions": questions},
        )
        response.raise_for_status()
        for text, item in zip(states, response.json()["results"]):
            for name, key in keys.items():
                self._cache[(text, key)] = item["answers"][name]

    async def probe(self, question: str) -> list[float]:
        """Ask one candidate question of the fixed probe set.

        Used by the gate, which needs to know what a question does before it
        is let near the stream. One call, one forward pass, ~800ms, and the
        answer is cached by the caller, so it happens once per new question.
        """
        response = await self._client.post(
            f"{self._endpoint}/ai/run/batch",
            json={"states": PROBES, "questions": {"probe": rule_question(question)}},
        )
        response.raise_for_status()
        return [item["answers"]["probe"]["noul"] for item in response.json()["results"]]

    def take_counts(self) -> tuple[int, int]:
        """Return (asked, reused) since the last call, then reset."""
        asked, reused = self.misses, self.hits
        self.misses = self.hits = 0
        return asked, reused
