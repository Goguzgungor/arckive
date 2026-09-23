"""Turn one USDC transfer and its transaction into a sentence the model reads.

The model gets the shape only: what kind of party sent to what kind of party,
a bucketed amount, and plain facts about the rest of the transaction.
Addresses never appear -- which wallet sent a swap says nothing about it being
a swap, and naming it would split one campaign into thousands of questions.
Amounts are bucketed rather than dropped because a near-zero value is the
signature of dust spam.
"""
from __future__ import annotations

from typing import TypedDict

from .signatures import FACT_BY_SELECTOR, FACT_BY_TOPIC, FACT_ORDER, FACT_PHRASE, protocol_of
from .types import DECIMALS, USDC, ZERO, Item, TxContext

EXPLORER = "https://explorer.arc.io/tx/"
_PLAIN_SELECTORS = {"0x", "0xa9059cbb", "0x23b872dd"}  # empty input, transfer, transferFrom


class Summary(TypedDict):
    id: str
    shape: str
    family: str
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
        return "0 USDC"
    if usdc < 0.01:
        return "less than one cent of USDC"
    if usdc < 1:
        return "under 1 USDC"
    if usdc < 100:
        return "1 to 100 USDC"
    if usdc < 10_000:
        return "100 to 10,000 USDC"
    return "over 10,000 USDC"


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


def summarize(item: Item) -> Summary:
    t, ctx, contracts = item["transfer"], item["ctx"], item["contracts"]
    bucket = amount_bucket(t["value"])
    if t["frm"] == ZERO:
        head = f"USDC was minted to {_party(t['to'], contracts)}, amount {bucket}."
    elif t["to"] == ZERO:
        head = f"USDC was burned from {_party(t['frm'], contracts)}, amount {bucket}."
    else:
        head = (f"USDC moved from {_party(t['frm'], contracts)} to "
                f"{_party(t['to'], contracts)}, amount {bucket}.")

    facts = facts_of(ctx)
    if ctx is None:
        tail = "The rest of the transaction could not be read."
    else:
        phrases = [FACT_PHRASE[f] for f in facts]
        if not phrases and ctx["selector"] in _PLAIN_SELECTORS and (ctx["to"] == USDC or ctx["selector"] == "0x"):
            phrases = ["it was a plain direct transfer"]
        if not phrases:
            phrases = ["nothing else recognisable happened"]
        tail = "In the same transaction: " + "; ".join(phrases) + "."

    shape = f"{head} {tail}"
    protocol = protocol_of(ctx)
    amount = round(t["value"] / 10**DECIMALS, 6)
    return {
        "id": f"{t['tx']}:{t['log_index']}",
        "shape": shape,
        "family": f"{protocol}|{shape}",
        "text": f"{amount:,.2f} USDC · {_short(t['frm'])} → {_short(t['to'])}",
        "protocol": protocol,
        "facts": facts,
        "amount": amount,
        "frm": t["frm"],
        "to": t["to"],
        "tx": t["tx"],
        "url": EXPLORER + t["tx"],
    }
