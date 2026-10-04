"""What the fine-tune asks of a transfer, and which askings it must never see.

A topic is one thing a viewer asks about a transfer -- "did it leave Arc
through a bridge?" -- answered from the transfer's reading: the facts its
story sentence states, the amount, what kind of party sent and received it,
the protocol the story names and which way a bridge went. The story is built
from exactly that reading (radar/summarize.py), so a topic's answer is what
the sentence the model reads can support. Where the sentence cannot decide --
an unknown party, a transaction that could not be read, a bridge with no
direction -- the truth is None and nothing is labelled: a label the sentence
cannot back would teach the model to guess.

Amount topics sit only on the bucket edges the story states (0.01, 1, 100 and
10,000 USDC). "Is it over 50 USDC?" has no topic, because "1 to 100 USDC"
cannot answer it.

Every phrasing carries its split. A training topic's last two English
phrasings and its last Turkish one never reach training; a held-out topic
never reaches training at all; Spanish, German and Russian are never trained.
They are how the report tells learning to read the story apart from learning
these words. See docs/superpowers/specs/2026-10-04-radar-laya-finetune-design.md.
"""
from __future__ import annotations

import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from radar.classify import CONTROL_QUESTION, RULE_PREFIX
from radar.signatures import bridge_direction
from radar.summarize import Summary
from radar.types import DECIMALS, ZERO, Item


@dataclass(frozen=True)
class Reading:
    """What the story sentence states about one transfer."""
    readable: bool          # False: "The rest of the transaction could not be read."
    facts: frozenset
    amount: float           # USDC
    frm: str                # "wallet", "contract", "account" (kind unknown) or "zero"
    to: str
    protocol: str           # as the story names it; "" when it names none
    direction: str          # "out", "in" or "" -- set only for bridges
    plain: bool             # "it was a plain direct transfer"


def _kind(address: str, contracts: dict) -> str:
    if address == ZERO:
        return "zero"
    if address not in contracts:
        return "account"
    return "contract" if contracts[address] else "wallet"


def reading_of(item: Item, summary: Summary) -> Reading:
    t, ctx = item["transfer"], item["ctx"]
    facts = frozenset(summary["facts"])
    return Reading(
        readable=ctx is not None,
        facts=facts,
        amount=t["value"] / 10**DECIMALS,
        frm=_kind(t["frm"], item["contracts"]),
        to=_kind(t["to"], item["contracts"]),
        # summarize() leaves "USDC" out of the story: it tells a question
        # nothing the rest of the sentence does not.
        protocol="" if summary["protocol"] == "USDC" else summary["protocol"],
        direction=bridge_direction(ctx) if "bridge" in facts else "",
        plain=summary["shape"].endswith("it was a plain direct transfer."),
    )


Truth = Callable[[Reading], Optional[bool]]


def _facts(*names: str) -> Truth:
    wanted = frozenset(names)
    return lambda r: bool(r.facts & wanted) if r.readable else None


def _bridge(direction: str) -> Truth:
    def truth(r: Reading) -> Optional[bool]:
        if not r.readable:
            return None
        if "bridge" not in r.facts:
            return False
        return r.direction == direction if r.direction else None
    return truth


def _protocol(name: str, fact: str = "") -> Truth:
    def truth(r: Reading) -> Optional[bool]:
        if not r.readable:
            return None
        return r.protocol == name and (not fact or fact in r.facts)
    return truth


def _party(side: str, kind: str) -> Truth:
    def truth(r: Reading) -> Optional[bool]:
        seen = getattr(r, side)
        return None if seen == "account" else seen == kind
    return truth


def _direct(r: Reading) -> Optional[bool]:
    if not r.readable or "account" in (r.frm, r.to):
        return None
    return r.plain and r.frm == "wallet" and r.to == "wallet"


def _spam(r: Reading) -> Optional[bool]:
    return (r.amount < 0.01 and not r.facts) if r.readable else None


# The same set eval.py's "Is this a DeFi transaction?" reads.
DEFI = ("swap", "liquidity", "vault", "lending", "bridge", "market", "wrap")


@dataclass(frozen=True)
class Topic:
    truth: Truth
    en: tuple
    tr: tuple
    other: tuple = ()        # (lang, text) pairs; never trained
    held_out: bool = False   # the whole topic stays out of training


TOPICS: dict[str, Topic] = {
    # ---- trained: four English and two Turkish phrasings train, the rest are held back
    "swap": Topic(_facts("swap", "market"), (
        "Were tokens swapped in this transaction?", "Did someone trade tokens here?",
        "Is this part of a token swap?", "Was this a trade on an exchange?",
        "Did this transfer come from swapping tokens?", "Is this an exchange trade?",
    ), ("Burada token takası yapıldı mı?", "Bu bir borsa işlemi mi?", "Bu transfer bir takasın parçası mı?"),
        (("es", "¿Es esto un intercambio de tokens?"), ("de", "Ist das ein Token-Tausch?"),
         ("ru", "Это обмен токенов?"))),
    "bridge": Topic(_facts("bridge"), (
        "Did these funds cross chains through a bridge?", "Was a bridge used here?",
        "Is this a cross-chain transfer?", "Did USDC move between blockchains?",
        "Is a bridge involved in this transaction?", "Was this sent across chains?",
    ), ("Bu transfer başka bir zincire köprülendi mi?", "Burada köprü kullanıldı mı?",
        "Bu zincirler arası bir transfer mi?"),
        (("es", "¿Pasó esto por un puente entre cadenas?"), ("de", "Ging das über eine Bridge?"),
         ("ru", "Это перевод через мост между блокчейнами?"))),
    "bridge_out": Topic(_bridge("out"), (
        "Is this USDC leaving Arc for another chain?", "Was USDC bridged out of Arc?",
        "Did the funds go from Arc to a different chain?", "Is money being sent off Arc?",
        "Is USDC being moved off Arc through a bridge?", "Did this transfer exit Arc?",
    ), ("USDC Arc'tan başka bir zincire mi gidiyor?", "Bu para Arc'tan çıkıyor mu?",
        "Fonlar Arc'tan köprüyle mi çıktı?")),
    "bridge_in": Topic(_bridge("in"), (
        "Did this USDC come into Arc from another chain?", "Was USDC bridged into Arc?",
        "Did the funds arrive on Arc through a bridge?", "Is money coming onto Arc from elsewhere?",
        "Did these funds reach Arc from a different blockchain?", "Was this bridged in?",
    ), ("Bu USDC başka bir zincirden Arc'a mı geldi?", "Para Arc'a köprüyle mi girdi?",
        "Fonlar Arc'a dışarıdan mı geldi?")),
    "over_10k": Topic(lambda r: r.amount >= 10_000, (
        "Is this more than 10,000 USDC?", "Was over ten thousand dollars moved?",
        "Is this a large transfer above 10,000 USDC?", "Did more than 10k USDC change hands?",
        "Is the amount above 10,000 USDC?", "Is this a transfer of at least ten thousand USDC?",
    ), ("Bu 10.000 USDC'nin üzerinde mi?", "On bin dolardan fazla mı gönderildi?",
        "Tutar 10.000 USDC'yi aşıyor mu?"),
        (("es", "¿Son más de 10.000 USDC?"), ("de", "Sind das mehr als 10.000 USDC?"),
         ("ru", "Это больше 10 000 USDC?"))),
    "over_100": Topic(lambda r: r.amount >= 100, (
        "Is this over 100 USDC?", "Was more than a hundred dollars sent?",
        "Is the amount at least 100 USDC?", "Did more than 100 USDC move?",
        "Is this transfer above 100 USDC?", "Is it more than a hundred USDC?",
    ), ("Bu 100 USDC'den fazla mı?", "Yüz dolardan fazla mı gönderildi?", "Tutar 100 USDC'nin üstünde mi?")),
    "under_1": Topic(lambda r: r.amount < 1, (
        "Is this under one dollar?", "Was less than 1 USDC sent?",
        "Is the amount below a dollar?", "Did less than one USDC move?",
        "Is this transfer smaller than 1 USDC?", "Is it worth less than a dollar?",
    ), ("Bu bir dolardan az mı?", "1 USDC'den az mı gönderildi?", "Tutar bir doların altında mı?"),
        (("es", "¿Es menos de un dólar?"), ("de", "Ist das weniger als ein Dollar?"),
         ("ru", "Это меньше одного доллара?"))),
    "under_cent": Topic(lambda r: r.amount < 0.01, (
        "Is this less than one cent?", "Was a fraction of a cent sent?",
        "Is the amount below 0.01 USDC?", "Is this a dust amount?",
        "Did less than a cent of USDC move?", "Is this a tiny dust transfer?",
    ), ("Bu bir sentten az mı?", "Gönderilen miktar toz kadar küçük mü?", "Tutar 0,01 USDC'nin altında mı?")),
    "zero_amount": Topic(lambda r: r.amount == 0, (
        "Was zero USDC sent?", "Is the amount exactly zero?",
        "Did no USDC actually move?", "Is this a zero-value transfer?",
        "Was nothing transferred in value?", "Is this an empty transfer of 0 USDC?",
    ), ("Sıfır USDC mi gönderildi?", "Tutar tam olarak sıfır mı?", "Bu sıfır değerli bir transfer mi?")),
    "direct_payment": Topic(_direct, (
        "Is this a plain payment from one wallet to another?", "Did one wallet simply pay another?",
        "Is this a simple wallet-to-wallet transfer?", "Was USDC sent directly between two people's wallets?",
        "Is this just a direct transfer between wallets?", "Did a wallet send USDC straight to another wallet?",
    ), ("Bu bir cüzdandan diğerine düz bir ödeme mi?", "Bir cüzdan diğerine doğrudan mı ödedi?",
        "Bu basit bir cüzdandan cüzdana transfer mi?")),
    "to_wallet": Topic(_party("to", "wallet"), (
        "Did the USDC end up in a wallet?", "Is the recipient a wallet?",
        "Was this sent to a personal wallet?", "Did a person's wallet get the funds?",
        "Is the receiver a wallet rather than a contract?", "Did the money go to a wallet?",
    ), ("USDC bir cüzdana mı gitti?", "Alıcı bir cüzdan mı?", "Para bir cüzdana mı gönderildi?"),
        (("es", "¿Recibió los USDC una billetera?"), ("de", "Hat eine Wallet die USDC erhalten?"),
         ("ru", "Получил ли USDC кошелёк?"))),
    "to_contract": Topic(_party("to", "contract"), (
        "Was the USDC sent to a contract?", "Is the recipient a smart contract?",
        "Did a contract receive the funds?", "Did the money go into a contract?",
        "Is the receiver a contract rather than a wallet?", "Did this transfer land in a smart contract?",
    ), ("USDC bir kontrata mı gönderildi?", "Alıcı bir akıllı kontrat mı?", "Para bir kontrata mı gitti?")),
    "from_wallet": Topic(_party("frm", "wallet"), (
        "Did the USDC come from a wallet?", "Is the sender a wallet?",
        "Was this sent by a personal wallet?", "Did a wallet pay this?",
        "Is the sender a wallet rather than a contract?", "Did the funds leave a wallet?",
    ), ("USDC bir cüzdandan mı geldi?", "Gönderen bir cüzdan mı?", "Para bir cüzdandan mı çıktı?")),
    "from_contract": Topic(_party("frm", "contract"), (
        "Did the USDC come from a contract?", "Is the sender a smart contract?",
        "Did a contract pay out these funds?", "Was this sent by a contract?",
        "Is the sender a contract rather than a wallet?", "Did the money leave a contract?",
    ), ("USDC bir kontrattan mı geldi?", "Gönderen bir akıllı kontrat mı?", "Para bir kontrattan mı çıktı?")),
    "minted": Topic(lambda r: r.frm == "zero", (
        "Was new USDC created here?", "Is this a USDC mint?",
        "Did new USDC come into existence?", "Was USDC issued in this transaction?",
        "Were fresh USDC tokens minted?", "Is this USDC being minted?",
    ), ("Yeni USDC basıldı mı?", "Bu bir USDC basımı mı?", "Bu işlemde USDC mi basıldı?")),
    "burned": Topic(lambda r: r.to == "zero", (
        "Was USDC destroyed here?", "Is this a USDC burn?",
        "Did USDC go out of existence?", "Was USDC burned in this transaction?",
        "Were USDC tokens burned?", "Is this USDC being burned?",
    ), ("USDC yakıldı mı?", "Bu bir USDC yakımı mı?", "Bu işlemde USDC mi yakıldı?")),
    "signed": Topic(_facts("signed"), (
        "Did the payer sign an authorization that someone else submitted?", "Was this a gasless payment?",
        "Is this a signed transfer submitted by a third party?", "Did someone else pay the gas for this payment?",
        "Was this payment authorized by signature?", "Is this a meta-transaction payment?",
    ), ("Ödeyen bir yetki imzalayıp başkası mı gönderdi?", "Bu gazsız bir ödeme mi?",
        "Bu ödeme imzayla mı yetkilendirildi?")),
    "defi": Topic(_facts(*DEFI), (
        "Is this a DeFi operation?", "Was a DeFi protocol involved?",
        "Is this decentralized finance activity?", "Did this use a DeFi app?",
        "Is this transfer part of DeFi?", "Did a DeFi protocol handle this?",
    ), ("Bu bir DeFi işlemi mi?", "Burada bir DeFi protokolü kullanıldı mı?", "Bu transfer DeFi'nin bir parçası mı?")),
    "vault": Topic(_facts("vault"), (
        "Were funds deposited into a vault?", "Did money go in or out of a vault?",
        "Is this a vault deposit?", "Was a vault used here?",
        "Did someone deposit into or withdraw from a vault?", "Is a vault involved?",
    ), ("Fonlar bir kasaya mı yatırıldı?", "Burada bir vault kullanıldı mı?",
        "Bu bir vault yatırma ya da çekme işlemi mi?")),
    "lending": Topic(_facts("lending"), (
        "Was a loan involved?", "Did someone borrow or repay?",
        "Is this a lending operation?", "Was a loan opened, repaid or liquidated?",
        "Is this borrowing or lending?", "Did a lending protocol handle this?",
    ), ("Burada bir kredi var mı?", "Biri borç aldı ya da ödedi mi?", "Bu bir borç verme işlemi mi?")),
    "wrap": Topic(_facts("wrap"), (
        "Was USDC wrapped or unwrapped?", "Did someone wrap USDC?",
        "Is this a wrapping of USDC?", "Was wrapped USDC involved?",
        "Did USDC get wrapped here?", "Was USDC unwrapped?",
    ), ("USDC sarmalandı mı?", "Burada USDC wrap edildi mi?", "Wrapped USDC kullanıldı mı?")),
    "cctp": Topic(_protocol("CCTP"), (
        "Was CCTP used?", "Did Circle's CCTP move this?",
        "Is this a CCTP transfer?", "Did this use the Cross-Chain Transfer Protocol?",
        "Was this routed via CCTP?", "Is CCTP behind this transfer?",
    ), ("CCTP kullanıldı mı?", "Bu bir CCTP transferi mi?", "Bu Circle CCTP ile mi gönderildi?")),
    "relay": Topic(_protocol("Relay"), (
        "Was Relay used?", "Did this go through Relay?",
        "Is this a Relay transfer?", "Did the Relay protocol handle this?",
        "Was this bridged with Relay?", "Is Relay behind this transaction?",
    ), ("Relay kullanıldı mı?", "Bu Relay üzerinden mi geçti?", "Bu bir Relay transferi mi?")),
    # ---- held out: never trained, only measured
    "smart_account": Topic(_facts("smart_account"), (
        "Was this sent from a smart account?", "Did an ERC-4337 smart account send this?",
        "Is the sender using a smart account?",
    ), ("Bu bir akıllı hesaptan mı gönderildi?",), held_out=True),
    "fee": Topic(_facts("fee"), (
        "Was a fee charged?", "Did someone take a fee here?", "Was a commission paid?",
    ), ("Burada bir ücret alındı mı?",), held_out=True),
    "liquidity": Topic(_facts("liquidity"), (
        "Did pool liquidity change?", "Was liquidity added to a pool?", "Is this a liquidity provision?",
    ), ("Havuz likiditesi değişti mi?",), held_out=True),
    "batch": Topic(_facts("batch"), (
        "Was this a batch of payments to many recipients?", "Did one sender pay many wallets at once?",
        "Is this a mass payout?",
    ), ("Bu birçok alıcıya toplu bir ödeme mi?",), held_out=True),
    "payout": Topic(_facts("payout"), (
        "Were rewards claimed?", "Is this a payout or reward distribution?", "Did someone claim a reward?",
    ), ("Ödül mü talep edildi?",), held_out=True),
    "market": Topic(_facts("market"), (
        "Were tokens bought or sold on a marketplace?", "Is this an NFT marketplace sale?",
        "Did a marketplace order get filled?",
    ), ("Bir pazar yerinde alım satım mı yapıldı?",), held_out=True),
    "spam": Topic(_spam, (
        "Is this spam?", "Is this a worthless spam transfer?", "Is this junk dust with nothing else happening?",
    ), ("Bu bir spam transfer mi?",), held_out=True),
    "uniswap": Topic(_protocol("Uniswap", "swap"), (
        "Did this trade happen on Uniswap?", "Was Uniswap used for this swap?", "Is this a swap on Uniswap?",
    ), ("Bu takas Uniswap'te mi yapıldı?",), held_out=True),
    "aerodrome": Topic(_protocol("Aerodrome", "swap"), (
        "Was this traded on Aerodrome?", "Did Aerodrome handle this swap?", "Is this an Aerodrome swap?",
    ), ("Bu takas Aerodrome'da mı yapıldı?",), held_out=True),
    "okx": Topic(_protocol("OKX DEX"), (
        "Was OKX DEX used?", "Did this go through OKX?", "Is this an OKX DEX swap?",
    ), ("Bu OKX DEX üzerinden mi geçti?",), held_out=True),
    "kyberswap": Topic(_protocol("KyberSwap"), (
        "Was this traded on KyberSwap?", "Did KyberSwap handle this?", "Is KyberSwap involved?",
    ), ("Bu KyberSwap'te mi işlem gördü?",), held_out=True),
    "oneinch": Topic(_protocol("1inch"), (
        "Was 1inch used?", "Did the 1inch router handle this?", "Is this a 1inch swap?",
    ), ("Bu 1inch ile mi yapıldı?",), held_out=True),
    "lifi": Topic(_protocol("LI.FI"), (
        "Was LI.FI used?", "Did LI.FI route this?", "Is this a LI.FI transfer?",
    ), ("Bu LI.FI üzerinden mi geçti?",), held_out=True),
}


@dataclass(frozen=True)
class Phrasing:
    topic: str
    text: str
    lang: str
    split: str   # "train", "heldout-phrasing", "heldout-topic" or "heldout-language"


def phrasings() -> list[Phrasing]:
    out: list[Phrasing] = []
    for key, topic in TOPICS.items():
        if topic.held_out:
            out += [Phrasing(key, t, "en", "heldout-topic") for t in topic.en]
            out += [Phrasing(key, t, "tr", "heldout-topic") for t in topic.tr]
        else:
            out += [Phrasing(key, t, "en", "train" if i < len(topic.en) - 2 else "heldout-phrasing")
                    for i, t in enumerate(topic.en)]
            out += [Phrasing(key, t, "tr", "train" if i < len(topic.tr) - 1 else "heldout-phrasing")
                    for i, t in enumerate(topic.tr)]
        out += [Phrasing(key, t, lang, "heldout-language") for lang, t in topic.other]
    return out


def truth(topic: str, reading: Reading) -> Optional[bool]:
    return TOPICS[topic].truth(reading)


# Questions nothing on chain answers, always labelled "no", so polished
# nonsense keeps answering every transfer alike and the gate keeps refusing
# it. None of them is eval.py's NONSENSE list, which stays a clean test, and
# none of them is about singing: the control question asks that, and it must
# stay a detector rather than a trained answer.
NONSENSE_TRAIN = (
    "is the sender wearing glasses?", "did this transfer enjoy the weekend?", "is the recipient a good dancer?",
    "does this payment prefer tea or coffee?", "was this transfer written in a poem?",
    "is the blockchain feeling tired?", "did a unicorn sign this?", "is the sender's favourite colour green?",
    "does the recipient play the piano?", "was this sent during a full moon?", "is this transfer afraid of the dark?",
    "does the USDC smell of roses?", "did the wallet watch a movie today?", "is the contract in love?",
    "does this transaction speak French?", "was the sender born in winter?", "is the recipient taller than six feet?",
    "did a cat walk across the keyboard?", "does this block have a garden?", "is the wallet hungry?",
    "did the payment go to the beach?", "is this transaction a vegetarian?", "does the sender have a brother?",
    "was this transfer painted blue?", "is the recipient good at chess?", "did this transfer win a race?",
    "does the contract like football?", "is the amount feeling lucky?", "did a ghost send this?",
    "gönderen gözlük takıyor mu?", "bu transfer hafta sonunu sevdi mi?", "alıcı iyi dans eder mi?",
)


def normalize(text: str) -> str:
    """The text two askings share when they are the same question."""
    text = unicodedata.normalize("NFKC", text).casefold().strip()
    text = re.sub(r"[?!.？！。]+$", "", text)
    return re.sub(r"\s+", " ", text).strip()


def forbidden() -> set[str]:
    """Every benchmark asking, normalised: none of these may be trained on."""
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    import eval as bench  # scripts/eval.py; imported late so this module loads without it

    texts = [q for q, _ in bench.QUESTIONS] + bench.ANSWERABLE + bench.UNANSWERABLE + bench.NONSENSE
    texts.append(CONTROL_QUESTION["instructions"])
    return {normalize(t) for t in texts} | {normalize(RULE_PREFIX + t) for t in texts}
