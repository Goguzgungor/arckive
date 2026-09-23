"""What a transaction's selectors and events say, in words the model can use.

A USDC Transfer on its own reads the same whether it is a swap leg, a bridge
deposit or a salary.  What tells them apart is everything else in the
transaction, so this table turns the function called and the events emitted
into a handful of plain facts.  It is static on purpose: a runtime lookup
service would add a dependency and a failure mode to every transaction.

The phrases matter more than they look.  Measured on 384 live transfers, lane
descriptions that reuse these exact phrases agreed with the rule labels 89% of
the time; the same lanes described abstractly agreed 4-50%.
"""
from __future__ import annotations

from .types import USDC, TxContext

FACT_ORDER = ["swap", "bridge", "liquidity", "vault", "lending", "signed", "smart_account", "fee"]

FACT_PHRASE = {
    "swap": "tokens were swapped on an exchange",
    "bridge": "funds were sent across chains through a bridge",
    "liquidity": "pool liquidity changed",
    "vault": "tokens were deposited into or withdrawn from a contract",
    "lending": "a loan was opened, repaid or liquidated",
    "signed": "the payer signed an authorization and someone else submitted it",
    "smart_account": "it was sent by a smart account",
    "fee": "a fee was taken",
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
    # bridge
    "0x8e0250ee": "bridge",  # depositForBurn — CCTP v2 TokenMessenger
    "0x779b432d": "bridge",  # depositForBurnWithHook — CCTP v2
    "0x57ecfd28": "bridge",  # receiveMessage — CCTP MessageTransmitter
    # liquidity
    "0xdd46508f": "liquidity",  # modifyLiquidities — Uniswap v4 PositionManager
    # signed
    "0xe3ee160e": "signed",  # transferWithAuthorization (EIP-3009)
    "0xef55bec6": "signed",  # receiveWithAuthorization (EIP-3009)
    # smart account
    "0x765e827f": "smart_account",  # handleOps — ERC-4337 EntryPoint v0.7/0.8
}

FACT_BY_TOPIC = {
    # swap
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67": "swap",  # Swap — Uniswap v3 pool
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
    # bridge
    "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5": "bridge",  # DepositForBurn — CCTP v2
    "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0": "bridge",  # DepositForBurn — CCTP v1
    "0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63": "bridge",  # MintAndWithdraw — CCTP v2
    "0x1b2a7ff080b8cb6ff436ce0372e399692bbfb6d4ae5766fd8d58a7b8cc6142e6": "bridge",  # MintAndWithdraw — CCTP v1
    "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036": "bridge",  # MessageSent — CCTP
    "0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1": "bridge",  # RelayErc20Deposit — Relay
    "0xafbab204e8271965231d37baed9b1abca8725b7409c70314455f68bc89142b91": "bridge",  # FundsMovement — Relay solver
    "0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1": "bridge",  # LiFiTransferStarted
    # liquidity
    "0x0f8712c47eb813e705bf827a60bdd551e6f2e055b4a1c2004304d52208a5a513": "liquidity",  # IncreaseLiquidity
    "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4": "liquidity",  # DecreaseLiquidity
    "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01": "liquidity",  # Collect — position manager
    "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0": "liquidity",  # Collect — v3 pool
    "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c": "liquidity",  # Burn — v3 pool
    "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde": "liquidity",  # Mint — v3 pool
    "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec": "liquidity",  # ModifyLiquidity — v4
    # vault
    "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c": "vault",  # Deposit(address,uint256) — wrapper
    "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65": "vault",  # Withdrawal(address,uint256)
    "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7": "vault",  # Deposit — ERC-4626
    "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db": "vault",  # Withdraw — ERC-4626
    # lending (Aave v3 pool events; none seen on Arc yet)
    "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0": "lending",  # Borrow
    "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": "lending",  # Supply
    "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": "lending",  # Repay
    "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7": "lending",  # Withdraw
    "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286": "lending",  # LiquidationCall
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

# First match wins, most specific first: a Relay deposit routed through the
# Universal Router is a bridge by Relay, not a Uniswap trade.
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
    ("Uniswap", {"0x3593564c", "0x04e45aaf", "0xdd46508f"},
     {"0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
      "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
      "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"}),
]


def protocol_of(ctx: TxContext | None) -> str:
    """A short name for who handled the transaction, or '' when unknown."""
    if ctx is None:
        return ""
    topics = set(ctx["topics"])
    for name, selectors, events in _PROTOCOL_RULES:
        if ctx["selector"] in selectors or topics & events:
            return name
    if ctx["to"] == USDC:
        return "USDC"
    return ""
