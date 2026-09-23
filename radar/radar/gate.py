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
sender a purple elephant?" -- sails through the text checks, and much of it
answers every transfer alike when it is asked of real ones.  Not all of it:
see MIN_SEPARATION.
"""
from __future__ import annotations

import math
import re
import unicodedata

from .sanitize import _INJECTION

MIN_CHARS = 6
MAX_CHARS = 160

# Forty-eight transfers covering what Arc actually carries: swap legs
# through routers and pools, bridge deposits and fills in both directions,
# liquidity moves, vaults and wrapping, lending, signed payments, smart-account
# sends, batch payouts, claims, marketplace sales, mints, burns, dust, zero
# transfers and plain ones.  A probe set sampled from the live stream would be
# mostly swap legs, and a fair question about anything else would look flat
# for want of an example to match -- so every fact and every protocol the
# radar names appears in at least two probes. With a fee in one probe of 24,
# "was a fee taken?" separated them by 0.08; and a topic in only one probe
# gets no yes line at all, because threshold() sets its most extreme probe
# aside. Written the way viewers' questions see a transfer -- summarize.py's
# `story` -- because that is what they are asked of.
PROBES = [
    "USDC moved from a wallet to a contract, amount 1 to 100 USDC (a small amount). In the same transaction: tokens were swapped on an exchange; a fee was taken. Protocol: Uniswap.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: tokens were swapped on an exchange. Protocol: Uniswap.",
    "USDC moved from a contract to a contract, amount under 1 USDC (less than a dollar). In the same transaction: tokens were swapped on an exchange. Protocol: Aerodrome.",
    "USDC moved from a wallet to a contract, amount over 10,000 USDC (a large amount). In the same transaction: tokens were swapped on an exchange.",
    "USDC moved from a contract to a wallet, amount less than one cent of USDC (dust). In the same transaction: tokens were swapped on an exchange; a fee was taken. Protocol: OKX DEX.",
    "USDC moved from a contract to a contract, amount 1 to 100 USDC (a small amount). In the same transaction: tokens were swapped on an exchange; USDC was wrapped or unwrapped; a fee was taken. Protocol: Uniswap.",
    "USDC moved from a wallet to a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: funds were sent across chains through a bridge (out of Arc). Protocol: Relay.",
    "USDC was burned from a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: funds were sent across chains through a bridge (out of Arc). Protocol: CCTP.",
    "USDC was minted to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: funds were sent across chains through a bridge (into Arc). Protocol: CCTP.",
    "USDC moved from a contract to a contract, amount 1 to 100 USDC (a small amount). In the same transaction: funds were sent across chains through a bridge (out of Arc); tokens were swapped on an exchange; it was sent by a smart account. Protocol: Relay.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: funds were sent across chains through a bridge (into Arc).",
    "USDC moved from a wallet to a contract, amount 1 to 100 USDC (a small amount). In the same transaction: funds were sent across chains through a bridge (out of Arc); tokens were swapped on an exchange; a fee was taken. Protocol: LI.FI.",
    "USDC moved from a wallet to a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: liquidity was added to or removed from a pool. Protocol: Uniswap.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: liquidity was added to or removed from a pool.",
    "USDC moved from a contract to a contract, amount under 1 USDC (less than a dollar). In the same transaction: liquidity was added to or removed from a pool; tokens were swapped on an exchange. Protocol: Aerodrome.",
    "USDC moved from a wallet to a contract, amount 1 to 100 USDC (a small amount). In the same transaction: funds were deposited into or withdrawn from a vault.",
    "USDC moved from a wallet to a contract, amount under 1 USDC (less than a dollar). In the same transaction: USDC was wrapped or unwrapped.",
    "USDC moved from a wallet to a contract, amount over 10,000 USDC (a large amount). In the same transaction: a loan was opened, repaid or liquidated.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: a loan was opened, repaid or liquidated.",
    "USDC moved from a wallet to a wallet, amount less than one cent of USDC (dust). In the same transaction: a gasless signed payment: the payer signed an authorization and someone else submitted it.",
    "USDC moved from a wallet to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: a gasless signed payment: the payer signed an authorization and someone else submitted it.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: it was sent by a smart account.",
    "USDC moved from a contract to a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: tokens were swapped on an exchange; it was sent by a smart account. Protocol: Uniswap.",
    "USDC moved from a wallet to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: it was a plain direct transfer.",
    "USDC moved from a wallet to a wallet, amount over 10,000 USDC (a large amount). In the same transaction: it was a plain direct transfer.",
    "USDC moved from a wallet to a wallet, amount less than one cent of USDC (dust). In the same transaction: it was a plain direct transfer.",
    "USDC moved from a wallet to a wallet, amount zero USDC. In the same transaction: nothing else recognisable happened.",
    "USDC moved from a contract to a wallet, amount zero USDC. In the same transaction: nothing else recognisable happened.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: a batch of payments was sent to many recipients.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: a batch of payments was sent to many recipients.",
    "USDC moved from a contract to a wallet, amount under 1 USDC (less than a dollar). In the same transaction: rewards or payouts were claimed or distributed.",
    "USDC moved from a wallet to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: tokens were bought or sold on a marketplace.",
    "USDC moved from an account to an account, amount 1 to 100 USDC (a small amount). The rest of the transaction could not be read.",
    "USDC was minted to a wallet, amount over 10,000 USDC (a large amount). In the same transaction: nothing else recognisable happened.",
    "USDC was burned from a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: nothing else recognisable happened.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: funds were deposited into or withdrawn from a vault.",
    "USDC moved from a wallet to a contract, amount over 10,000 USDC (a large amount). In the same transaction: funds were deposited into or withdrawn from a vault.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: rewards or payouts were claimed or distributed.",
    "USDC moved from a wallet to a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: tokens were bought or sold on a marketplace.",
    "USDC moved from an account to an account, amount 100 to 10,000 USDC (a medium amount). The rest of the transaction could not be read.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: tokens were swapped on an exchange; a fee was taken. Protocol: LI.FI.",
    "USDC moved from a wallet to a contract, amount 1 to 100 USDC (a small amount). In the same transaction: tokens were swapped on an exchange; a fee was taken. Protocol: OKX DEX.",
    "USDC moved from a wallet to a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: tokens were swapped on an exchange. Protocol: KyberSwap.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: tokens were swapped on an exchange. Protocol: KyberSwap.",
    "USDC moved from a wallet to a contract, amount 1 to 100 USDC (a small amount). In the same transaction: tokens were swapped on an exchange. Protocol: 1inch.",
    "USDC moved from a contract to a wallet, amount 100 to 10,000 USDC (a medium amount). In the same transaction: tokens were swapped on an exchange. Protocol: 1inch.",
    "USDC moved from a contract to a wallet, amount 1 to 100 USDC (a small amount). In the same transaction: tokens were swapped on an exchange. Protocol: 0x.",
    "USDC moved from a wallet to a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: tokens were swapped on an exchange. Protocol: 0x.",
]

# Below this the question put every probe in the same place, so it would put
# every transfer in the same place too.  Set so that no question the radar can
# answer is turned away: of 37 answerable questions in scripts/eval.py the
# weakest, "was a fee taken?", separates the probes by 0.17 (the 0.20 this
# replaced refused it), while "is this a payroll or salary payment?", which
# nothing on chain records, falls below. So do 8 of 14 polished-nonsense
# questions; the rest separate the probes as well as a weak real question does
# -- the model answers "does this payment like jazz music?" differently for
# payments than for swaps -- and cannot be told apart this way. The page shows
# those how weakly they sort.
MIN_SEPARATION = 0.12

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


def threshold(scores: list[float]) -> float:
    """Where a yes starts, for one question, from its answers over the probes.

    A question's answers are not centred on 0.5. "Was a fee taken?" put every
    transfer that paid one near 0.1 and every other near 0.01, and "is this
    spam or dust?" put its yeses near 0.05 -- ranked almost perfectly, read as
    "no" at 0.5. The line is halfway between the probes' low and high answers
    in log-odds, where the model decides, rather than in probability, where
    such answers crowd against zero; the most extreme probe on each side is
    set aside, so one odd probe cannot drag it -- which is why every topic has
    two probes. It never reaches 0 or 1, where every row, or none, would be a
    yes.

    Measured on 4,000 live transfers, over the 20 questions with ten or more
    yeses and noes: balanced accuracy 0.762 at a flat 0.5, 0.767 at the
    probability midpoint, 0.820 at this one.
    """
    if len(scores) < 4:
        return 0.5
    ranked = sorted(scores)
    low, high = _logit(ranked[1]), _logit(ranked[-2])
    line = 1 / (1 + math.exp(-(low + high) / 2))
    return round(min(0.99, max(0.01, line)), 4)


def _logit(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


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
