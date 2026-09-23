"""What a transaction's selectors and events say, in words the model can use.

A USDC Transfer on its own reads the same whether it is a swap leg, a bridge
deposit or a salary.  What tells them apart is everything else in the
transaction, so this table turns the function called and the events emitted
into a handful of plain facts.  It is static on purpose: a runtime lookup
service would add a dependency and a failure mode to every transaction.

Every entry was checked against what the transactions carrying it actually
did -- who gave what and who got what back, read from the receipts -- not
only against the event's name.  That audit removed one fact that was wrong
(see FundsMovement below) and added the ones that most of the unrecognised
transfers turned out to be.

The phrases matter more than they look.  Measured on 384 live transfers, lane
descriptions that reuse these exact phrases agreed with the rule labels 89% of
the time; the same lanes described abstractly agreed 4-50%.
"""
from __future__ import annotations

from .types import USDC, TxContext

# The order the facts are read out in. Bridge comes before swap: a transfer
# that swaps and then leaves for another chain is a bridge transfer, and the
# lane descriptions in classify.py say so in the same order.
FACT_ORDER = ["bridge", "liquidity", "lending", "vault", "swap", "market", "batch", "payout",
              "wrap", "signed", "smart_account", "fee"]

# The words the lane question reads.
FACT_PHRASE = {
    "swap": "tokens were swapped on an exchange",
    "bridge": "funds were sent across chains through a bridge",
    "liquidity": "pool liquidity changed",
    "lending": "a loan was opened, repaid or liquidated",
    "vault": "funds were deposited into or withdrawn from a vault",
    "wrap": "USDC was wrapped or unwrapped",
    "market": "tokens were bought or sold on a marketplace",
    "batch": "a batch of payments was sent to many recipients",
    "payout": "rewards or payouts were claimed or distributed",
    "signed": "the payer signed an authorization and someone else submitted it",
    "smart_account": "it was sent by a smart account",
    "fee": "a fee was taken",
}

# The words viewers' questions read, where they differ. Worded for the
# questions people ask rather than for the lanes: on 24 test questions over
# ten minutes of mainnet, "liquidity was added to or removed from a pool" and
# naming the gasless payment lifted the average AUC, while the same words in
# the lane sentence cost the lanes accuracy -- so the two sentences differ.
STORY_PHRASE = {
    **FACT_PHRASE,
    "liquidity": "liquidity was added to or removed from a pool",
    "signed": "a gasless signed payment: the payer signed an authorization and someone else submitted it",
}

FACT_BY_SELECTOR = {
    # swap
    "0x3593564c": "swap",   # execute(bytes,bytes[],uint256) — Uniswap Universal Router
    "0x04e45aaf": "swap",   # exactInputSingle — Uniswap SwapRouter02
    "0x38ed1739": "swap",   # swapExactTokensForTokens — v2-style router
    "0x0c307f76": "swap",   # dagSwapTo — OKX DEX
    "0x0d5f0e3b": "swap",   # uniswapV3SwapTo — OKX DEX
    "0xf2c42696": "swap",   # dagSwapByOrderId — OKX DEX
    "0x44014e98": "swap",   # uniswapV3SwapToWithBaseRequest — OKX DEX
    "0x4d819a2a": "swap",   # swap((uint8,...)[],address,...) — aggregator router
    "0xe21fd0e9": "swap",   # swap(...) — KyberSwap MetaAggregationRouterV2
    "0x07ed2379": "swap",   # swap(address,(...),bytes) — 1inch AggregationRouterV6
    "0x2f139e4f": "swap",   # execute_route(...)
    "0x3e0f9c3c": "swap",   # axiomTrade(bytes,bytes[],uint256)
    "0x2213bc0b": "swap",   # exec(...) — 0x AllowanceHolder
    "0x2afaca20": "swap",   # buy(uint256,address,uint256) — bonding-curve launchpad
    "0x40993b26": "swap",   # buy(uint256,uint256,uint256) — bonding-curve launchpad
    # bridge
    "0x8e0250ee": "bridge",  # depositForBurn — CCTP v2 TokenMessenger
    "0x779b432d": "bridge",  # depositForBurnWithHook — CCTP v2
    "0x57ecfd28": "bridge",  # receiveMessage — CCTP MessageTransmitter
    "0xdeff4b24": "bridge",  # fillRelay — Across-style spoke pool, filling a deposit made elsewhere
    "0x7e7fc653": "bridge",  # fillOrderOutputs — cross-chain intent settlement (ERC-7683 style)
    "0x3ce33bff": "bridge",  # bridge(string,address,uint256,bytes)
    "0x6e1537da": "bridge",  # swapAndBridge(bytes32,address,address,uint256,bytes,bytes,bytes,bytes)
    # liquidity
    "0xdd46508f": "liquidity",  # modifyLiquidities — Uniswap v4 PositionManager
    # marketplace
    "0x87201b41": "market",  # fulfillAvailableAdvancedOrders — Seaport
    "0xf2d12b12": "market",  # matchAdvancedOrders — Seaport
    "0xe7acab24": "market",  # fulfillAdvancedOrder — Seaport
    # batch payments: one sender, many recipients, no event of their own
    "0xe63d38ed": "batch",  # disperseEther(address[],uint256[])
    "0xc73a2d60": "batch",  # disperseToken(address,address[],uint256[])
    "0x51ba162c": "batch",  # disperseTokenSimple(address,address[],uint256[])
    # payouts
    "0x1e83409a": "payout",  # claim(address)
    "0x4e71d92d": "payout",  # claim()
    "0xe4fc6b6d": "payout",  # distribute()
    # signed
    "0xe3ee160e": "signed",  # transferWithAuthorization (EIP-3009)
    "0xef55bec6": "signed",  # receiveWithAuthorization (EIP-3009)
    # smart account
    "0x765e827f": "smart_account",  # handleOps — ERC-4337 EntryPoint v0.7/0.8
    "0xb61d27f6": "smart_account",  # execute(address,uint256,bytes) — smart-account entry point
    "0x34fcd5be": "smart_account",  # executeBatch((address,uint256,bytes)[])
    "0x2d9fb478": "smart_account",  # execute(((address,bytes,uint256,bool)[],uint256,uint256),bytes)
}

FACT_BY_TOPIC = {
    # swap
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67": "swap",  # Swap — Uniswap v3 pool and its forks
    "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f": "swap",  # Swap — Uniswap v4 PoolManager
    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822": "swap",  # Swap — v2 pair
    "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a": "swap",  # Swap(...,tuple[]) — aggregator
    "0xd6d4f5681c246c9f42c203e287975af1601f8df8035a9251f79aab5c8f09e2f8": "swap",  # Swapped
    "0x20efd6d5195b7b50273f01cd79a27989255356f9f13293edc53ee142accfdb75": "swap",  # Swap(address,address,address,address,uint256,uint256)
    "0x7bfdfdb5e3a3776976e53cb0607060f54c5312701c8cba1155cc4d5394440b38": "swap",  # AssetSwapped — LI.FI
    "0x38eee76fd911eabac79da7af16053e809be0e12c8637f156e77e1af309b99537": "swap",  # LiFiGenericSwapCompleted
    "0x1bb43f2da90e35f7b0cf38521ca95a49e68eb42fac49924930a5bd73cdf7576c": "swap",  # OrderRecord — OKX DEX
    "0x7724394874fdd8ad13292ec739b441f85c6559f10dc4141b8d4c0fa4cbf55bdb": "swap",  # SwapOrderId — OKX DEX
    "0xa6fee24309b1d83d9ec7b9e4dbb73c6f882746efbfb26db7b7d9e9f2fb6dc95a": "swap",  # Exchange(address,address,address,uint256,uint256)
    "0x2c5cc05b9a7b53e2478a9af1c94ec079b5be7c669be3df98ad86d28237f689e7": "swap",  # Buy — bonding-curve launchpad
    "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455": "swap",  # CurveBuy — bonding-curve launchpad
    "0xc1742a443d639e06cae611e6969aa3e066a8edf9ca632e4d45b9167f487d1785": "swap",  # CurveBuy — bonding-curve launchpad
    "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df": "swap",  # CurveSell — bonding-curve launchpad
    "0xcf93b133041e0c9edcb77b3088a72ce25e769d56f3df661c1b0db04a3fe7fa0d": "swap",  # CurveSell — bonding-curve launchpad
    # bridge. Relay's FundsMovement is deliberately absent: the Relay router
    # logs it whenever it moves funds, same-chain swaps included, and read as
    # a bridge it filed ~150 ordinary swaps in ten minutes as bridge transfers.
    # A Relay bridge deposit is RelayErc20Deposit, logged by the Depository.
    "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5": "bridge",  # DepositForBurn — CCTP v2
    "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0": "bridge",  # DepositForBurn — CCTP v1
    "0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63": "bridge",  # MintAndWithdraw — CCTP v2
    "0x1b2a7ff080b8cb6ff436ce0372e399692bbfb6d4ae5766fd8d58a7b8cc6142e6": "bridge",  # MintAndWithdraw — CCTP v1
    "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036": "bridge",  # MessageSent — CCTP
    "0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1": "bridge",  # RelayErc20Deposit — Relay Depository
    "0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1": "bridge",  # LiFiTransferStarted
    "0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208": "bridge",  # FilledRelay — Across-style spoke pool
    "0xfef24569acf839f2b5cb23fd59d8a9bcc21650ff711ac1961ca3c5d4681ffe12": "bridge",  # OutputFilled — cross-chain intent settlement
    # liquidity
    "0x0f8712c47eb813e705bf827a60bdd551e6f2e055b4a1c2004304d52208a5a513": "liquidity",  # IncreaseLiquidity
    "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4": "liquidity",  # DecreaseLiquidity
    "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01": "liquidity",  # Collect — position manager
    "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0": "liquidity",  # Collect — v3 pool
    "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c": "liquidity",  # Burn — v3 pool
    "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde": "liquidity",  # Mint — v3 pool
    "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec": "liquidity",  # ModifyLiquidity — v4
    # vault
    "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7": "vault",  # Deposit — ERC-4626
    "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db": "vault",  # Withdraw — ERC-4626
    # wrap. WETH-style Deposit/Withdrawal is the wrapped-USDC contract that
    # routers use for native USDC: on mainnet every one of these sat inside
    # a swap, so reading them as "a vault" put vaults where there were none.
    "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c": "wrap",  # Deposit(address,uint256)
    "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65": "wrap",  # Withdrawal(address,uint256)
    # lending (Aave v3 pool events; none seen on Arc yet)
    "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0": "lending",  # Borrow
    "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": "lending",  # Supply
    "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": "lending",  # Repay
    "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7": "lending",  # Withdraw
    "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286": "lending",  # LiquidationCall
    # marketplace
    "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31": "market",  # OrderFulfilled — Seaport
    # payouts
    "0xf7a40077ff7a04c7e61f6f26fb13774259ddf1b6bce9ecf26a8276cdd3992683": "payout",  # Claimed(address,address,uint256)
    "0xf7576d8c2653e9d07af5ef229acf59b339e327d4e0eaddb4a96615534cf148f8": "payout",  # Distributed(uint256,uint256,uint256,uint256)
    "0x2105469e420e4f1c383a7b27c355d98d617715055986873b1963dedba114d59c": "payout",  # DividendFunded(address,uint256)
    "0x9def4e2802183d68ce90a6a226a2962b59298616c27165f12c4fbc5c84cdd778": "payout",  # Paid(address,address,uint256)
    # signed
    "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5": "signed",  # AuthorizationUsed
    # smart account
    "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f": "smart_account",  # UserOperationEvent
    # fee
    "0x7970b0744fdb6cf0b120e5e0a5f4da3ab8cbec6d5d9ec8a4f327ccc1d8a5eb8b": "fee",  # CommissionAndTrimInfo — OKX
    "0xcd5eae9d9d0b96532bd1b7dbf6628ce436b2af735829087a03c548439f8bf850": "fee",  # CommissionFromTokenRecord — OKX
    "0x3cfb523a4c38d88561dd3bf04805a31715c8b5fc468a03b8d684356f360dea99": "fee",  # CommissionToTokenRecord — OKX
    "0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92": "fee",  # FeeCollected
    "0x3a7029951ba36c1af37954df919ce2f9a95c3f5c2c2e872d5e7fd47c61a6df26": "fee",  # FeesForwarded — LI.FI
    "0x2cbc7a49494b955fc97f275d59dab3e8cb331287723f93b9505b81482cfd1b98": "fee",  # FeeCharged
    "0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d": "fee",  # HookFeeCollected
}

# Which way a bridge transfer went, for the questions viewers ask ("is USDC
# leaving Arc?"). Only the lane-neutral story carries it: in the lane sentence
# "sent to another chain" read to the model as a payment.
BRIDGE_OUT = {
    "0x8e0250ee", "0x779b432d", "0x6e1537da", "0x3ce33bff",
    "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5",
    "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0",
    "0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1",
    "0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1",
}
BRIDGE_IN = {
    "0x57ecfd28", "0xdeff4b24", "0x7e7fc653",
    "0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63",
    "0x1b2a7ff080b8cb6ff436ce0372e399692bbfb6d4ae5766fd8d58a7b8cc6142e6",
    "0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208",
    "0xfef24569acf839f2b5cb23fd59d8a9bcc21650ff711ac1961ca3c5d4681ffe12",
}

# Events logged by pools that answer factory() -- Uniswap-v3 style Swap, Mint,
# Burn and Collect, and the v2 pair's Swap. The feed asks each such pool once
# who deployed it (see arc.py), so a liquidity move is named as surely as a
# trade on the same pool.
POOL_TOPICS = {
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",  # Swap — v3 pool
    "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",  # Mint — v3 pool
    "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",  # Burn — v3 pool
    "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0",  # Collect — v3 pool
    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",  # Swap — v2 pair
}

# Uniswap on Arc, from developers.uniswap.org's v4 deployment list. Arc is on
# no Uniswap v3 list, but the factory below runs the canonical UniswapV3Factory
# bytecode (identical once its own address, an immutable, is masked).
UNISWAP_V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
UNISWAP_ENTRY_POINTS = {
    "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",  # Universal Router
    "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b",  # v4 PositionManager
}
FACTORY_NAMES = {
    "0xf0db7b58379503491d857db50ac9ece64c653918": "Uniswap",    # UniswapV3Factory bytecode
    "0xb89df768af2cfe637ceb352c587fe8edaf491d03": "Aerodrome",  # Aero Lite CL factory
}

# First match wins, most specific first: a Relay deposit routed through the
# Universal Router is a bridge by Relay, not a Uniswap trade. Matched on the
# function called and the events logged; Uniswap and Aerodrome are matched on
# addresses instead (see venue_of), because their events are shared by forks.
_PROTOCOL_RULES: list[tuple[str, set[str], set[str]]] = [
    ("CCTP", {"0x8e0250ee", "0x779b432d", "0x57ecfd28"},
     {"0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5",
      "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0",
      "0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63",
      "0x1b2a7ff080b8cb6ff436ce0372e399692bbfb6d4ae5766fd8d58a7b8cc6142e6"}),
    ("Relay", set(),
     {"0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1"}),
    ("LI.FI", set(),
     {"0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1",
      "0x38eee76fd911eabac79da7af16053e809be0e12c8637f156e77e1af309b99537",
      "0x7bfdfdb5e3a3776976e53cb0607060f54c5312701c8cba1155cc4d5394440b38"}),
    ("OKX DEX", {"0x0c307f76", "0x0d5f0e3b", "0xf2c42696", "0x44014e98"},
     {"0x1bb43f2da90e35f7b0cf38521ca95a49e68eb42fac49924930a5bd73cdf7576c"}),
    ("KyberSwap", {"0xe21fd0e9"}, set()),
    ("1inch", {"0x07ed2379"}, set()),
    ("0x", {"0x2213bc0b"}, set()),
]


def bridge_direction(ctx: TxContext | None) -> str:
    """'out' of Arc, 'in' to Arc, or '' when the transaction does not say (or says both)."""
    if ctx is None:
        return ""
    marks = {ctx["selector"], *ctx["topics"]}
    out, into = bool(marks & BRIDGE_OUT), bool(marks & BRIDGE_IN)
    return "out" if out and not into else "in" if into and not out else ""


def venue_of(ctx: TxContext) -> str:
    """The exchange a transaction traded on, from the addresses involved."""
    if ctx.get("to") in UNISWAP_ENTRY_POINTS or UNISWAP_V4_POOL_MANAGER in ctx.get("emitters", []):
        return "Uniswap"
    for factory in ctx.get("factories", {}).values():
        if factory in FACTORY_NAMES:
            return FACTORY_NAMES[factory]
    return ""


def protocol_of(ctx: TxContext | None) -> str:
    """A short name for who handled the transaction, or '' when unknown."""
    if ctx is None:
        return ""
    topics = set(ctx["topics"])
    for name, selectors, events in _PROTOCOL_RULES:
        if ctx["selector"] in selectors or topics & events:
            return name
    venue = venue_of(ctx)
    if venue:
        return venue
    # The USDC contract called directly, or USDC sent as plain value -- which
    # on Arc is the same money moving natively. Neither is "an unknown
    # contract", which is what the page says when this is empty.
    if ctx["to"] == USDC or ctx["selector"] == "0x":
        return "USDC"
    return ""
