# radar/radar/types.py
from __future__ import annotations
from typing import TypedDict

USDC = "0x3600000000000000000000000000000000000000"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x0000000000000000000000000000000000000000"
DECIMALS = 6


class Transfer(TypedDict):
    tx: str          # 0x-prefixed lowercase tx hash
    log_index: int
    block: int
    frm: str         # 0x-prefixed lowercase address
    to: str
    value: int       # raw units, 6 decimals


class TxContext(TypedDict):
    to: str | None   # tx.to, lowercase; None for contract creation
    selector: str    # first 4 bytes of input, "0x" + 8 hex; "0x" when input is empty
    topics: list[str]  # topic0 of every log in the receipt, lowercase, in log order


class Item(TypedDict):
    transfer: Transfer
    ctx: TxContext | None        # None when tx/receipt could not be fetched
    contracts: dict[str, bool]   # address -> has code; may lack an address
    seen_at: float               # time.time() when the feed emitted it
