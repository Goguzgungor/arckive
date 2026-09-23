# radar/radar/types.py
from __future__ import annotations
from typing import TypedDict

USDC = "0x3600000000000000000000000000000000000000"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x0000000000000000000000000000000000000000"
DECIMALS = 6

# USDC is Arc's native currency, and every native movement is logged as a
# Transfer from this system address, in 18 decimals. A call through the ERC-20
# interface at USDC logs the same movement twice, once here and once there; a
# plain value send, or value passed into a contract call, is logged only here.
# Measured on ten minutes of mainnet: 76% of all USDC movements appeared only
# here, so a feed that read the ERC-20 interface alone missed most of Arc.
NATIVE = "0xfffffffffffffffffffffffffffffffffffffffe"
NATIVE_DECIMALS = 18

# ERC-4337 EntryPoints (v0.6, v0.7, v0.8). After every bundle an EntryPoint
# pays the bundler back for gas with a native transfer, which is gas and not
# anything the account did; a plain transaction pays gas with no log at all.
ENTRYPOINTS = frozenset({
    "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
    "0x0000000071727de22e5e9d8baf0edac6f37da032",
    "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
})


class Transfer(TypedDict):
    tx: str          # 0x-prefixed lowercase tx hash
    log_index: int
    block: int
    frm: str         # 0x-prefixed lowercase address
    to: str
    value: int       # raw units, 6 decimals; a native movement is rounded up, so none reads as zero


class TxContext(TypedDict):
    to: str | None   # tx.to, lowercase; None for contract creation
    selector: str    # first 4 bytes of input, "0x" + 8 hex; "0x" when input is empty
    topics: list[str]  # topic0 of every log in the receipt, lowercase, in log order
    sender: str      # tx.from, lowercase
    emitters: list[str]  # the address that emitted each of `topics`, same order
    factories: dict[str, str]  # pool address -> the factory that deployed it, for this transaction's pools


class Item(TypedDict):
    transfer: Transfer
    ctx: TxContext | None        # None when tx/receipt could not be fetched
    contracts: dict[str, bool]   # address -> is a contract (a 7702-delegated EOA is a wallet); may lack an address
    seen_at: float               # time.time() when the feed emitted it
