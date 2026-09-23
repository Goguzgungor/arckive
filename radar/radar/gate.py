"""Screen a viewer's question before it is put to the network.

Two filters, because each one is blind exactly where the other sees.

Reading a question tells you nothing: asked to sort twenty real questions from
sixteen nonsense ones by their wording alone, the model called fourteen of the
real ones nonsense.  It is a decision model over descriptions of things, not a
judge of sentences, and asking it to grade a question is asking it to do the
one job it was not built for.

So the words are checked here, in plain code, and the meaning is checked by
running the question and watching what it does.  Gibberish -- "asdfgh",
"aaaaaaaa", "12345" -- reads as a confident question to the model and is
trivial to catch with a regular expression.  Polished nonsense -- "is the
sender a purple elephant?" -- sails through the text checks and collapses the
moment it is asked of real transfers, because it separates nothing.
"""
from __future__ import annotations

import re
import unicodedata

from .sanitize import _INJECTION

MIN_CHARS = 6
MAX_CHARS = 160

# Twenty-four transfer shapes covering what Arc actually carries: swap legs
# through routers and pools, bridge deposits and CCTP burns, liquidity moves,
# wrapping, lending, signed payments, smart-account sends, mints, burns, dust
# and plain transfers.  A probe set sampled from the live stream would be
# mostly swap legs, and a fair question about anything else would look flat
# for want of an example to match.
PROBES = [
    "USDC moved from a wallet to a contract, amount 1 to 100 USDC. In the same transaction: tokens were swapped on an exchange; a fee was taken.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC. In the same transaction: tokens were swapped on an exchange.",
    "USDC moved from a contract to a contract, amount under 1 USDC. In the same transaction: tokens were swapped on an exchange.",
    "USDC moved from a wallet to a contract, amount over 10,000 USDC. In the same transaction: tokens were swapped on an exchange.",
    "USDC moved from a wallet to a contract, amount 100 to 10,000 USDC. In the same transaction: funds were sent across chains through a bridge.",
    "USDC was burned from a wallet, amount 100 to 10,000 USDC. In the same transaction: funds were sent across chains through a bridge.",
    "USDC was minted to a wallet, amount 1 to 100 USDC. In the same transaction: funds were sent across chains through a bridge.",
    "USDC moved from a contract to a contract, amount 1 to 100 USDC. In the same transaction: tokens were swapped on an exchange; funds were sent across chains through a bridge; it was sent by a smart account.",
    "USDC moved from a wallet to a contract, amount 100 to 10,000 USDC. In the same transaction: pool liquidity changed.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC. In the same transaction: pool liquidity changed.",
    "USDC moved from a wallet to a contract, amount 1 to 100 USDC. In the same transaction: tokens were deposited into or withdrawn from a contract.",
    "USDC moved from a wallet to a contract, amount over 10,000 USDC. In the same transaction: a loan was opened, repaid or liquidated.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC. In the same transaction: a loan was opened, repaid or liquidated.",
    "USDC moved from a wallet to a wallet, amount less than one cent of USDC. In the same transaction: the payer signed an authorization and someone else submitted it.",
    "USDC moved from a wallet to a wallet, amount 1 to 100 USDC. In the same transaction: the payer signed an authorization and someone else submitted it.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC. In the same transaction: it was sent by a smart account.",
    "USDC moved from a wallet to a wallet, amount 1 to 100 USDC. In the same transaction: it was a plain direct transfer.",
    "USDC moved from a wallet to a wallet, amount over 10,000 USDC. In the same transaction: it was a plain direct transfer.",
    "USDC moved from a wallet to a wallet, amount 0 USDC. In the same transaction: it was a plain direct transfer.",
    "USDC moved from a wallet to a wallet, amount less than one cent of USDC. In the same transaction: nothing else recognisable happened.",
    "USDC was minted to a wallet, amount over 10,000 USDC. In the same transaction: nothing else recognisable happened.",
    "USDC was burned from a contract, amount 100 to 10,000 USDC. In the same transaction: nothing else recognisable happened.",
    "USDC moved from a contract to a wallet, amount under 1 USDC. In the same transaction: a fee was taken.",
    "USDC moved from an account to an account, amount 1 to 100 USDC. The rest of the transaction could not be read.",
]

# Below this the question put every probe in the same place, so it would put
# every operation in the same place too.  Set from measurement: the weakest
# real question in the test set separates by 0.23, the strongest nonsense that
# survives the text checks by 0.16.
MIN_SEPARATION = 0.20

_WORD = re.compile(r"[a-z]{2,}")
_VOWEL = re.compile(r"[aeiouy]")
_OPEN = re.compile(r"^\s*(what|why|who|when|where|which|how|whose|whom|explain|"
                   r"describe|tell|show|list|summari[sz]e|give)\b", re.IGNORECASE)
_FUTURE = re.compile(r"\b(tomorrow|next (week|month|year)|going to be|predict|"
                     r"forecast|will .*\b(be|rise|fall|go|happen|reach|profit))", re.IGNORECASE)
# A yes/no question either ends in a question mark or opens with an auxiliary.
# Filler prose -- "lorem ipsum dolor sit amet", "test test test" -- does
# neither, and reads to the model as a strongly discriminating question.
_ASKS = re.compile(r"^\s*(is|are|was|were|does|do|did|has|have|had|can|could|"
                   r"should|would|may|might|must|am)\b", re.IGNORECASE)

# Every refusal says what is wrong and what to do instead. None of them
# apologise, and none of them leave the viewer guessing which rule they hit.
REASONS = {
    "short": "Too short to ask. Give it a few more words.",
    "long": f"Longer than {MAX_CHARS} characters. One question, one sentence.",
    "gibberish": "That is not a question yet. Try: is this a swap on an exchange?",
    "open": "This one wants an essay. The radar answers yes or no — "
            "try starting with is, does or did.",
    "statement": "Not a question. End it with a question mark, or start it "
                 "with is, does or did.",
    "future": "The radar reads transfers as they land. It does not forecast.",
    "injection": "That reads as an instruction, not a question about the transfers.",
    "flat": "Asked of every kind of transfer, this question answered the same "
            "every time, so it would sort nothing. Try something a transfer records: "
            "an amount, who it moves between, what else happened in the transaction.",
    # Not about the question at all: checking one costs the shared model a
    # forward pass, so new ones are paced per viewer and budgeted overall.
    "slow": "One question every few seconds.",
    "busy": "Many people are asking right now. Try again in a minute.",
}


def inspect(text: str) -> str:
    """Judge a question by its words alone. Returns a reason key, or ''.

    Instant and certain, and it runs first so that the nine questions out of
    ten that are simply empty, pasted, or a single word never reach the GPU.
    """
    text = unicodedata.normalize("NFKC", text).strip()
    if len(text) < MIN_CHARS:
        return "short"
    if len(text) > MAX_CHARS:
        return "long"
    if _INJECTION.search(text):
        return "injection"

    words = _WORD.findall(text.lower())
    # "asdfgh" and "aaaaaaaa" are one long word with no vowel or no variety;
    # "12345" and "??????" have no words at all. All three read to the model
    # as a perfectly confident question.
    if len(words) < 2:
        return "gibberish"
    if not any(_VOWEL.search(w) for w in words):
        return "gibberish"
    if all(len(set(w)) <= 2 for w in words):
        return "gibberish"
    if _FUTURE.search(text):
        return "future"
    if _OPEN.match(text):
        return "open"
    if not text.endswith("?") and not _ASKS.match(text):
        return "statement"
    if len(set(words)) == 1:
        return "gibberish"
    return ""


def separation(scores: list[float]) -> float:
    """How far apart the question pulled the probes, top fifth to bottom fifth.

    Counting how many came back high would be the wrong measure: a question
    that is right about one operation in twenty puts nineteen at the bottom,
    which is the correct answer and not a flat one.
    """
    ranked = sorted(scores, reverse=True)
    edge = max(2, len(ranked) // 5)
    top = sum(ranked[:edge]) / edge
    bottom = sum(ranked[-edge:]) / edge
    return top - bottom
