"""Transfers the live stream rarely carries, built so the radar's own code reads them.

Ten minutes of mainnet is mostly swap legs; lending has not been seen on Arc
at all, and bridges into Arc are a handful an hour. A question about them
would have almost nothing to learn from. These recipes are the transaction
kinds the fact table knows -- the selector called, the events logged, the
contract addressed -- and every synthetic transfer goes through the real
summarize(), so its sentences are the radar's own, byte for byte. They are
training data only: every figure the report gives comes from real captures.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Optional

from radar.types import USDC, ZERO, Item

UR = "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1"                 # Uniswap Universal Router
POSITION_MANAGER = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b"   # Uniswap v4 PositionManager
AERODROME_FACTORY = "0xb89df768af2cfe637ceb352c587fe8edaf491d03"

SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
HOOK_FEE = "0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d"
OKX_FEE = "0x7970b0744fdb6cf0b120e5e0a5f4da3ab8cbec6d5d9ec8a4f327ccc1d8a5eb8b"
RELAY_DEPOSIT = "0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1"
LIFI_STARTED = "0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1"
FEES_FORWARDED = "0x3a7029951ba36c1af37954df919ce2f9a95c3f5c2c2e872d5e7fd47c61a6df26"
INCREASE_LIQUIDITY = "0x0f8712c47eb813e705bf827a60bdd551e6f2e055b4a1c2004304d52208a5a513"
MINT_V3 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"
ERC4626_DEPOSIT = "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7"
ERC4626_WITHDRAW = "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db"
WRAP_DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"
WRAP_WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65"
BORROW = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0"
REPAY = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051"
ORDER_FULFILLED = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31"
CLAIMED = "0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683"
AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"
USER_OP = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"

UNKNOWN = "0xdeadbeef"   # a selector the fact table does not know


@dataclass(frozen=True)
class Recipe:
    name: str
    selector: str
    topics: tuple = ()
    to: Optional[str] = None            # tx.to; another contract when None
    pool_factory: Optional[str] = None  # the factory that deployed the pool emitting `topics`
    mint: bool = False                  # the transfer comes from the zero address
    burn: bool = False                  # the transfer goes to the zero address
    readable: bool = True


RECIPES = [
    Recipe("uniswap_swap", "0x3593564c", (SWAP_V3,), to=UR),
    Recipe("uniswap_swap_fee", "0x3593564c", (SWAP_V3, HOOK_FEE), to=UR),
    Recipe("okx_swap_fee", "0x0c307f76", (OKX_FEE,)),
    Recipe("kyber_swap", "0xe21fd0e9"),
    Recipe("oneinch_swap", "0x07ed2379"),
    Recipe("zerox_swap", "0x2213bc0b"),
    Recipe("aerodrome_swap", "0x38ed1739", (SWAP_V3,), pool_factory=AERODROME_FACTORY),
    Recipe("launchpad_buy", "0x2afaca20"),
    Recipe("cctp_out", "0x8e0250ee", burn=True),
    Recipe("cctp_in", "0x57ecfd28", mint=True),
    Recipe("relay_out", UNKNOWN, (RELAY_DEPOSIT,)),
    Recipe("relay_swap_out", "0x3593564c", (SWAP_V3, RELAY_DEPOSIT), to=UR),
    Recipe("lifi_out_fee", UNKNOWN, (LIFI_STARTED, FEES_FORWARDED)),
    Recipe("across_fill_in", "0xdeff4b24"),
    Recipe("intent_fill_in", "0x7e7fc653"),
    Recipe("liquidity_v4", "0xdd46508f", to=POSITION_MANAGER),
    Recipe("liquidity_v3", UNKNOWN, (INCREASE_LIQUIDITY,)),
    Recipe("liquidity_aerodrome", UNKNOWN, (MINT_V3,), pool_factory=AERODROME_FACTORY),
    Recipe("vault_deposit", UNKNOWN, (ERC4626_DEPOSIT,)),
    Recipe("vault_withdraw", UNKNOWN, (ERC4626_WITHDRAW,)),
    Recipe("wrap", UNKNOWN, (WRAP_DEPOSIT,)),
    Recipe("wrap_swap", "0x3593564c", (SWAP_V3, WRAP_WITHDRAWAL), to=UR),
    Recipe("lending_borrow", UNKNOWN, (BORROW,)),
    Recipe("lending_repay", UNKNOWN, (REPAY,)),
    Recipe("seaport", "0x87201b41", (ORDER_FULFILLED,)),
    Recipe("disperse", "0xc73a2d60"),
    Recipe("claim", "0x4e71d92d", (CLAIMED,)),
    Recipe("signed", "0xe3ee160e", (AUTH_USED,), to=USDC),
    Recipe("smart_account", "0x765e827f", (USER_OP,)),
    Recipe("smart_account_swap", "0x765e827f", (SWAP_V3, USER_OP)),
    Recipe("plain_erc20", "0xa9059cbb", to=USDC),
    Recipe("plain_native", "0x"),
    Recipe("unknown_call", "0x12345678"),
    Recipe("unreadable", UNKNOWN, readable=False),
    Recipe("issuance_mint", "0x40c10f19", to=USDC, mint=True),
    Recipe("issuance_burn", "0x42966c68", to=USDC, burn=True),
]

# One raw value (6 decimals) per amount bucket summarize() names:
# zero, dust, under a dollar, small, medium, large.
AMOUNTS = (0, 4_000, 500_000, 25_000_000, 2_500_000_000, 50_000_000_000)

WALLETS = ("0x" + "a1" * 20, "0x" + "a2" * 20)
CONTRACTS = ("0x" + "c1" * 20, "0x" + "c2" * 20)
POOL = "0x" + "b1" * 20
EMITTER = "0x" + "e1" * 20
ELSEWHERE = "0x" + "c9" * 20
KNOWN = {**{w: False for w in WALLETS}, **{c: True for c in CONTRACTS}}
PARTIES = (("wallet", "contract"), ("contract", "wallet"), ("contract", "contract"), ("wallet", "wallet"))


def _address(kind: str, slot: int) -> str:
    return ZERO if kind == "zero" else (WALLETS if kind == "wallet" else CONTRACTS)[slot]


def _item(recipe: Recipe, frm_kind: str, to_kind: str, value: int, n: int) -> Item:
    frm, to = _address(frm_kind, 0), _address(to_kind, 1)
    ctx = None
    if recipe.readable:
        ctx = {
            "to": recipe.to or ELSEWHERE,
            "selector": recipe.selector,
            "topics": list(recipe.topics),
            "sender": frm if frm != ZERO else WALLETS[0],
            "emitters": [POOL if recipe.pool_factory else EMITTER for _ in recipe.topics],
            "factories": {POOL: recipe.pool_factory} if recipe.pool_factory else {},
        }
    return {
        "transfer": {"tx": "0x%064x" % n, "log_index": 0, "block": 0, "frm": frm, "to": to, "value": value},
        "ctx": ctx,
        "contracts": dict(KNOWN),
        "seen_at": 0.0,
    }


def labelled() -> Iterator[tuple[Item, str]]:
    """Every synthetic transfer with the recipe it came from, in a fixed order."""
    n = 0
    for recipe in RECIPES:
        if recipe.mint:
            pairs = (("zero", "wallet"), ("zero", "contract"))
        elif recipe.burn:
            pairs = (("wallet", "zero"), ("contract", "zero"))
        else:
            pairs = PARTIES
        for frm_kind, to_kind in pairs:
            for value in AMOUNTS:
                n += 1
                yield _item(recipe, frm_kind, to_kind, value, n), recipe.name


def items() -> list[Item]:
    return [it for it, _ in labelled()]
