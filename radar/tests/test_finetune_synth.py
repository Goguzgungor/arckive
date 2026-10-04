from finetune import synth
from radar.signatures import FACT_ORDER
from radar.summarize import summarize

# recipe -> (facts, protocol as summarize() names it, bridge direction word in the story)
EXPECT = {
    "uniswap_swap": (["swap"], "Uniswap", ""),
    "uniswap_swap_fee": (["swap", "fee"], "Uniswap", ""),
    "okx_swap_fee": (["swap", "fee"], "OKX DEX", ""),
    "kyber_swap": (["swap"], "KyberSwap", ""),
    "oneinch_swap": (["swap"], "1inch", ""),
    "zerox_swap": (["swap"], "0x", ""),
    "aerodrome_swap": (["swap"], "Aerodrome", ""),
    "launchpad_buy": (["swap"], "", ""),
    "cctp_out": (["bridge"], "CCTP", "(out of Arc)"),
    "cctp_in": (["bridge"], "CCTP", "(into Arc)"),
    "relay_out": (["bridge"], "Relay", "(out of Arc)"),
    "relay_swap_out": (["bridge", "swap"], "Relay", "(out of Arc)"),
    "lifi_out_fee": (["bridge", "fee"], "LI.FI", "(out of Arc)"),
    "across_fill_in": (["bridge"], "", "(into Arc)"),
    "intent_fill_in": (["bridge"], "", "(into Arc)"),
    "liquidity_v4": (["liquidity"], "Uniswap", ""),
    "liquidity_v3": (["liquidity"], "", ""),
    "liquidity_aerodrome": (["liquidity"], "Aerodrome", ""),
    "vault_deposit": (["vault"], "", ""),
    "vault_withdraw": (["vault"], "", ""),
    "wrap": (["wrap"], "", ""),
    "wrap_swap": (["swap", "wrap"], "Uniswap", ""),
    "lending_borrow": (["lending"], "", ""),
    "lending_repay": (["lending"], "", ""),
    "seaport": (["market"], "", ""),
    "disperse": (["batch"], "", ""),
    "claim": (["payout"], "", ""),
    "signed": (["signed"], "USDC", ""),
    "smart_account": (["smart_account"], "", ""),
    "smart_account_swap": (["swap", "smart_account"], "", ""),
    "plain_erc20": ([], "USDC", ""),
    "plain_native": ([], "USDC", ""),
    "unknown_call": ([], "", ""),
    "unreadable": ([], "", ""),
    "issuance_mint": ([], "USDC", ""),
    "issuance_burn": ([], "USDC", ""),
}


def _first(name):
    return next(it for it, r in synth.labelled() if r == name)


def test_every_recipe_reads_as_intended():
    assert set(EXPECT) == {r.name for r in synth.RECIPES}
    for name, (facts, protocol, direction) in EXPECT.items():
        s = summarize(_first(name))
        assert s["facts"] == facts, name
        assert s["protocol"] == protocol, name
        if direction:
            assert direction in s["story"], name


def test_the_stories_cover_every_fact_and_named_protocol():
    stories = [summarize(it) for it in synth.items()]
    assert set(FACT_ORDER) <= {f for s in stories for f in s["facts"]}
    named = {s["protocol"] for s in stories}
    assert {"CCTP", "Relay", "LI.FI", "OKX DEX", "KyberSwap", "1inch", "0x", "Uniswap", "Aerodrome"} <= named


def test_mint_burn_plain_and_unreadable_render():
    stories = {summarize(it)["story"].split(",")[0] for it in synth.items()}
    assert "USDC was minted to a wallet" in stories and "USDC was burned from a contract" in stories
    texts = [summarize(it)["story"] for it in synth.items()]
    assert any(t.endswith("it was a plain direct transfer.") for t in texts)
    assert any("could not be read" in t for t in texts)
    assert any("amount zero USDC" in t for t in texts)
    assert any("(a large amount)" in t for t in texts)


def test_items_are_deterministic():
    assert synth.items() == synth.items()
