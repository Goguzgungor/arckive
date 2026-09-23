import pytest

from radar.types import USDC, ZERO

WALLET = "0x1111111111111111111111111111111111111111"
WALLET2 = "0x2222222222222222222222222222222222222222"
POOL = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
ROUTER = "0x4e3bcce28caf98a143fd8bd9e4875ccab3e7bbe0"
TX = "0x" + "ab" * 32


def make_item(*, frm=WALLET, to=WALLET2, value=12_340_000, selector="0x", tx_to=USDC,
              topics=None, contracts=None, ctx=True, log_index=3):
    transfer = {"tx": TX, "log_index": log_index, "block": 22_316_000, "frm": frm, "to": to, "value": value}
    context = None
    if ctx:
        context = {"to": tx_to, "selector": selector,
                   "topics": topics if topics is not None else ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}
    if contracts is None:
        contracts = {WALLET: False, WALLET2: False, POOL: True, ROUTER: True}
    return {"transfer": transfer, "ctx": context, "contracts": contracts, "seen_at": 1_758_600_000.0}


@pytest.fixture
def item():
    return make_item
