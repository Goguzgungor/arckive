"""Turn one USDC transfer and its transaction into sentences the model reads.

The model gets the shape only: what kind of party sent to what kind of party,
a bucketed amount, and plain facts about the rest of the transaction.
Addresses never appear -- which wallet sent a swap says nothing about it being
a swap, and naming it would split one campaign into thousands of questions.
Amounts are bucketed rather than dropped because a near-zero value is the
signature of dust spam.

Two sentences come out, because two different questions are asked. The lane
is read from `shape`, worded to match the lane descriptions. Viewers'
questions are read from `story`, which adds what those questions are about --
a size in words, which way a bridge went, the protocol -- and which, in the
lane sentence, cost the lanes accuracy (see classify.py).
"""
from __future__ import annotations

from typing import TypedDict

from .signatures import (
    FACT_BY_SELECTOR, FACT_BY_TOPIC, FACT_ORDER, FACT_PHRASE, STORY_PHRASE, bridge_direction, protocol_of,
)
from .types import DECIMALS, USDC, ZERO, Item, TxContext

EXPLORER = "https://explorer.arc.io/tx/"
_PLAIN_SELECTORS = {"0x", "0xa9059cbb", "0x23b872dd"}  # empty input, transfer, transferFrom

# Facts that describe who sent a transaction or what it cost, not what it did.
# A zero transfer with only these beside it still did nothing.
_INCIDENTAL = {"smart_account", "fee"}


class Summary(TypedDict):
    id: str
    shape: str
    story: str
    family: str
    ruled: str
    text: str
    protocol: str
    facts: list[str]
    amount: float
    frm: str
    to: str
    tx: str
    url: str


def amount_bucket(value: int) -> str:
    usdc = value / 10**DECIMALS
    if value == 0:
        return "zero USDC"
    if usdc < 0.01:
        return "less than one cent of USDC"
    if usdc < 1:
        return "under 1 USDC"
    if usdc < 100:
        return "1 to 100 USDC"
    if usdc < 10_000:
        return "100 to 10,000 USDC"
    return "over 10,000 USDC"


# A bucket read as "1 to 100 USDC" answered "is this less than a dollar?"
# backwards (AUC 0.35 on mainnet): the model does not compare numbers it is
# given as words. It does read a size said in words.
_SIZE = {
    "less than one cent of USDC": "dust",
    "under 1 USDC": "less than a dollar",
    "1 to 100 USDC": "a small amount",
    "100 to 10,000 USDC": "a medium amount",
    "over 10,000 USDC": "a large amount",
}


def amount_words(value: int) -> str:
    bucket = amount_bucket(value)
    size = _SIZE.get(bucket)
    return f"{bucket} ({size})" if size else bucket


def facts_of(ctx: TxContext | None) -> list[str]:
    if ctx is None:
        return []
    found = set()
    if ctx["selector"] in FACT_BY_SELECTOR:
        found.add(FACT_BY_SELECTOR[ctx["selector"]])
    for topic in ctx["topics"]:
        fact = FACT_BY_TOPIC.get(topic)
        if fact:
            found.add(fact)
    return [f for f in FACT_ORDER if f in found]


def _party(address: str, contracts: dict[str, bool]) -> str:
    if address not in contracts:
        return "an account"
    return "a contract" if contracts[address] else "a wallet"


def _short(address: str) -> str:
    return f"{address[:6]}…{address[-4:]}"


def _head(item: Item, amount: str) -> str:
    t, contracts = item["transfer"], item["contracts"]
    if t["frm"] == ZERO:
        return f"USDC was minted to {_party(t['to'], contracts)}, amount {amount}."
    if t["to"] == ZERO:
        return f"USDC was burned from {_party(t['frm'], contracts)}, amount {amount}."
    return f"USDC moved from {_party(t['frm'], contracts)} to {_party(t['to'], contracts)}, amount {amount}."


def _plain(ctx: TxContext | None, facts: list[str]) -> bool:
    return (ctx is not None and not facts and ctx["selector"] in _PLAIN_SELECTORS
            and (ctx["to"] == USDC or ctx["selector"] == "0x"))


def _tail(ctx: TxContext | None, facts: list[str], phrase: dict[str, str], direction: str = "") -> str:
    if ctx is None:
        return "The rest of the transaction could not be read."
    phrases = []
    for f in facts:
        words = phrase[f]
        if f == "bridge" and direction:
            words += " (out of Arc)" if direction == "out" else " (into Arc)"
        phrases.append(words)
    if not phrases:
        phrases = ["it was a plain direct transfer" if _plain(ctx, facts) else "nothing else recognisable happened"]
    return "In the same transaction: " + "; ".join(phrases) + "."


def ruled_lane(item: Item, facts: list[str]) -> str:
    """The lane the transfer itself decides, or '' when it is the model's call.

    Mint and burn are not a judgement: one side is the zero address or it is
    not, and as a model option "issuance" drew probability from every other
    lane (93.5% agreement with it offered, 99.9% without). A transfer of zero
    USDC with nothing else happening carried nothing and is spam; a sub-cent
    one is not, because on Arc a sub-cent native send is how a new wallet gets
    its gas -- all 40 recipients of the busiest such sender had spent it on
    exactly one transaction.

    And where nothing in the transaction is recognisable, there is nothing for
    the model to read: asked anyway it answered "vault" at 0.82 or "lending"
    at 0.64 depending only on the wording, so those rows say uncertain.
    """
    t, ctx = item["transfer"], item["ctx"]
    if ctx is None:
        return "uncertain"
    if ZERO in (t["frm"], t["to"]) and "bridge" not in facts:
        return "issuance"
    if t["value"] == 0 and not set(facts) - _INCIDENTAL:
        return "spam"
    if not facts and not _plain(ctx, facts):
        return "uncertain"
    return ""


def summarize(item: Item) -> Summary:
    t, ctx = item["transfer"], item["ctx"]
    facts = facts_of(ctx)
    protocol = protocol_of(ctx)
    shape = f"{_head(item, amount_bucket(t['value']))} {_tail(ctx, facts, FACT_PHRASE)}"
    story = f"{_head(item, amount_words(t['value']))} {_tail(ctx, facts, STORY_PHRASE, bridge_direction(ctx))}"
    # "USDC" only says the ERC-20 contract was called directly; as a protocol
    # it would tell a question nothing the rest of the sentence does not.
    if protocol and protocol != "USDC":
        story += f" Protocol: {protocol}."
    amount = round(t["value"] / 10**DECIMALS, 6)
    return {
        "id": f"{t['tx']}:{t['log_index']}",
        "shape": shape,
        "story": story,
        # Rows collapse on this. The story already names the protocol, and it
        # tells apart transfers the lanes read alike but a question would not,
        # such as a bridge leaving Arc and one arriving.
        "family": story,
        "ruled": ruled_lane(item, facts),
        "text": f"{amount:,.2f} USDC · {_short(t['frm'])} → {_short(t['to'])}",
        "protocol": protocol,
        "facts": facts,
        "amount": amount,
        "frm": t["frm"],
        "to": t["to"],
        "tx": t["tx"],
        "url": EXPLORER + t["tx"],
    }
