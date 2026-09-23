from conftest import POOL, ROUTER, TX, WALLET, WALLET2, make_item

from radar.signatures import FACT_ORDER, protocol_of
from radar.summarize import amount_bucket, facts_of, summarize
from radar.types import USDC, ZERO

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
OKX_ORDER = "0x1bb43f2da90e35f7b0cf38521ca95a49e68eb42fac49924930a5bd73cdf7576c"
OKX_COMMISSION = "0x7970b0744fdb6cf0b120e5e0a5f4da3ab8cbec6d5d9ec8a4f327ccc1d8a5eb8b"
RELAY_DEPOSIT = "0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1"
CCTP_BURN_V2 = "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5"
AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"
USER_OP = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"
DECREASE_LIQ = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4"
AAVE_SUPPLY = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61"
WRAP_DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"


def test_amount_buckets():
    assert amount_bucket(0) == "0 USDC"
    assert amount_bucket(9_999) == "less than one cent of USDC"
    assert amount_bucket(10_000) == "under 1 USDC"
    assert amount_bucket(999_999) == "under 1 USDC"
    assert amount_bucket(1_000_000) == "1 to 100 USDC"
    assert amount_bucket(99_999_999) == "1 to 100 USDC"
    assert amount_bucket(100_000_000) == "100 to 10,000 USDC"
    assert amount_bucket(10_000_000_000) == "over 10,000 USDC"


def test_okx_swap_leg():
    it = make_item(frm=WALLET, to=ROUTER, value=49_880_000, selector="0x0c307f76", tx_to=ROUTER,
                   topics=[TRANSFER, OKX_ORDER, V3_SWAP, OKX_COMMISSION, TRANSFER])
    s = summarize(it)
    assert s["shape"] == ("USDC moved from a wallet to a contract, amount 1 to 100 USDC. "
                          "In the same transaction: tokens were swapped on an exchange; a fee was taken.")
    assert s["protocol"] == "OKX DEX"
    assert s["facts"] == ["swap", "fee"]
    assert s["amount"] == 49.88
    assert s["id"] == f"{TX}:3"
    assert s["url"] == f"https://explorer.arc.io/tx/{TX}"
    assert s["family"] == "OKX DEX|" + s["shape"]
    assert s["text"] == "49.88 USDC · 0x1111…1111 → 0x4e3b…bbe0"


def test_uniswap_universal_router():
    it = make_item(frm=POOL, to=WALLET, selector="0x3593564c", tx_to="0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
                   topics=[TRANSFER, V4_SWAP])
    s = summarize(it)
    assert s["protocol"] == "Uniswap"
    assert s["shape"].startswith("USDC moved from a contract to a wallet, amount 1 to 100 USDC.")
    assert s["facts"] == ["swap"]


def test_relay_bridge_via_smart_account():
    it = make_item(frm=WALLET, to=POOL, value=132_800_000, selector="0x765e827f",
                   tx_to="0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
                   topics=[TRANSFER, RELAY_DEPOSIT, V3_SWAP, USER_OP])
    s = summarize(it)
    assert s["facts"] == ["swap", "bridge", "smart_account"]
    assert s["protocol"] == "Relay"
    assert "funds were sent across chains through a bridge" in s["shape"]
    assert "it was sent by a smart account" in s["shape"]


def test_cctp_burn():
    it = make_item(frm=WALLET, to=ZERO, value=500_000_000, selector="0x8e0250ee",
                   tx_to="0x28b5a0e9c621a5badaa536219b3a228c8168cf5d", topics=[TRANSFER, CCTP_BURN_V2])
    s = summarize(it)
    assert s["protocol"] == "CCTP"
    assert s["shape"] == ("USDC was burned from a wallet, amount 100 to 10,000 USDC. "
                          "In the same transaction: funds were sent across chains through a bridge.")


def test_signed_payment():
    it = make_item(value=5_000, selector="0xe3ee160e", tx_to=USDC, topics=[AUTH_USED, TRANSFER])
    s = summarize(it)
    assert s["facts"] == ["signed"]
    assert s["shape"] == ("USDC moved from a wallet to a wallet, amount less than one cent of USDC. "
                          "In the same transaction: the payer signed an authorization and someone else submitted it.")
    assert s["protocol"] == "USDC"


def test_plain_transfer():
    s = summarize(make_item(selector="0xa9059cbb", tx_to=USDC, topics=[TRANSFER]))
    assert s["shape"] == ("USDC moved from a wallet to a wallet, amount 1 to 100 USDC. "
                          "In the same transaction: it was a plain direct transfer.")
    assert s["protocol"] == "USDC"


def test_native_value_send_is_plain():
    s = summarize(make_item(selector="0x", tx_to=WALLET2, topics=[TRANSFER]))
    assert "it was a plain direct transfer" in s["shape"]
    assert s["protocol"] == ""


def test_liquidity_lending_vault():
    assert facts_of({"to": POOL, "selector": "0xdd46508f", "topics": [DECREASE_LIQ]}) == ["liquidity"]
    assert facts_of({"to": POOL, "selector": "0x00000000", "topics": [AAVE_SUPPLY]}) == ["lending"]
    assert facts_of({"to": POOL, "selector": "0x00000000", "topics": [WRAP_DEPOSIT]}) == ["vault"]


def test_unknown_contract():
    s = summarize(make_item(selector="0xdeadbeef", tx_to=POOL, topics=[TRANSFER, "0x" + "12" * 32]))
    assert s["shape"].endswith("In the same transaction: nothing else recognisable happened.")
    assert s["protocol"] == ""


def test_missing_context():
    s = summarize(make_item(ctx=False))
    assert s["shape"].endswith("The rest of the transaction could not be read.")
    assert s["facts"] == []


def test_mint_and_burn_wording():
    minted = summarize(make_item(frm=ZERO, to=WALLET, selector="0x", tx_to=None, topics=[TRANSFER]))
    assert minted["shape"].startswith("USDC was minted to a wallet, amount")
    burned = summarize(make_item(frm=POOL, to=ZERO, topics=[TRANSFER]))
    assert burned["shape"].startswith("USDC was burned from a contract, amount")
    assert "a wallet" not in burned["shape"].split(",")[0]


def test_unknown_party_is_an_account():
    s = summarize(make_item(contracts={}))
    assert s["shape"].startswith("USDC moved from an account to an account,")


def test_shape_has_no_addresses_or_exact_amounts():
    s = summarize(make_item(value=49_880_000))
    assert "0x" not in s["shape"]
    assert "49.88" not in s["shape"]


def test_fact_order_is_stable():
    assert FACT_ORDER == ["swap", "bridge", "liquidity", "vault", "lending", "signed", "smart_account", "fee"]
    a = facts_of({"to": POOL, "selector": "0x", "topics": [OKX_COMMISSION, V3_SWAP]})
    assert a == ["swap", "fee"]


def test_protocol_of_none():
    assert protocol_of(None) == ""
