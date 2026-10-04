import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval as bench  # noqa: E402
from capture import load  # noqa: E402

from finetune.questions import (  # noqa: E402
    NONSENSE_TRAIN, TOPICS, forbidden, normalize, phrasings, reading_of, truth,
)
from radar.summarize import summarize  # noqa: E402

# eval.py's questions whose truth this bank also defines. Left out: the
# Uniswap question (eval names the venue from addresses, which the story does
# not show when another protocol is named), "a large swap" (two topics at
# once) and the Turkish repeats of English ones.
SAME = {
    "Is this a swap?": "swap",
    "Is this a bridge transfer?": "bridge",
    "Is USDC leaving Arc through a bridge?": "bridge_out",
    "Did these funds arrive from another chain?": "bridge_in",
    "Is this transfer over 10,000 USDC?": "over_10k",
    "Is this more than 100 USDC?": "over_100",
    "Is this less than one dollar?": "under_1",
    "Was it sent by a smart account?": "smart_account",
    "Was a fee taken?": "fee",
    "Is this a direct payment between two wallets?": "direct_payment",
    "Did a wallet receive the USDC?": "to_wallet",
    "Did the USDC go into a contract?": "to_contract",
    "Is this spam or dust?": "spam",
    "Is liquidity being added or removed?": "liquidity",
    "Was USDC minted?": "minted",
    "Is this a gasless signed payment?": "signed",
    "Did this go through CCTP?": "cctp",
    "Is this a DeFi transaction?": "defi",
    "Is this a batch payout to many wallets?": "batch",
    "Is this a vault deposit or withdrawal?": "vault",
    "Were rewards claimed or paid out?": "payout",
    "Was something bought on a marketplace?": "market",
    "Is this a KyberSwap trade?": "kyberswap",
    "Did this go through 1inch?": "oneinch",
    "Was this routed through LI.FI?": "lifi",
}


@pytest.fixture(scope="module")
def fixture_rows():
    return [(it, summarize(it)) for it in load()]


def test_truths_agree_with_eval_wherever_the_story_decides(fixture_rows):
    truths = dict(bench.QUESTIONS)
    checked = 0
    for question, topic in SAME.items():
        for it, s in fixture_rows:
            ours = truth(topic, reading_of(it, s))
            if ours is None:
                continue
            assert ours == truths[question](it, s), (question, s["story"])
            checked += 1
    assert checked > 10_000


def test_one_story_reads_one_way(fixture_rows):
    seen: dict = {}
    for it, s in fixture_rows:
        r = reading_of(it, s)
        for topic in TOPICS:
            seen.setdefault((s["story"], topic), set()).add(truth(topic, r))
    assert all(len(v) == 1 for v in seen.values())


def test_training_topics_hold_back_two_english_and_one_turkish():
    for key, topic in TOPICS.items():
        mine = [p for p in phrasings() if p.topic == key]
        if topic.held_out:
            assert len(topic.en) == 3 and len(topic.tr) == 1, key
            assert {p.split for p in mine if p.lang in ("en", "tr")} == {"heldout-topic"}, key
            continue
        assert len(topic.en) == 6 and len(topic.tr) == 3, key
        split = {(p.lang, p.split): 0 for p in mine}
        for p in mine:
            split[(p.lang, p.split)] += 1
        assert split[("en", "train")] == 4 and split[("en", "heldout-phrasing")] == 2, key
        assert split[("tr", "train")] == 2 and split[("tr", "heldout-phrasing")] == 1, key


def test_other_languages_never_train_and_cover_a_non_latin_script():
    others = [p for p in phrasings() if p.lang not in ("en", "tr")]
    assert {p.split for p in others} == {"heldout-language"}
    assert {"es", "de", "ru"} <= {p.lang for p in others}


def test_about_a_third_of_topics_are_held_out():
    held = sum(t.held_out for t in TOPICS.values())
    assert 0.25 <= held / len(TOPICS) <= 0.4


def test_no_training_question_is_a_benchmark_question():
    banned = forbidden()
    assert normalize("Is this a swap?") in banned
    for p in phrasings():
        if p.split == "train":
            assert normalize(p.text) not in banned, p.text
    for text in NONSENSE_TRAIN:
        assert normalize(text) not in banned, text


def test_every_phrasing_is_unique():
    texts = [normalize(p.text) for p in phrasings()] + [normalize(t) for t in NONSENSE_TRAIN]
    assert len(texts) == len(set(texts))


def test_normalize_ignores_case_spacing_and_the_question_mark():
    assert normalize("  bu bir SWAP  mı ") == normalize("Bu bir swap mı?")
    assert normalize("Is this a swap?!") == normalize("is this a swap")


def test_what_the_story_cannot_decide_is_not_labelled(item):
    unread = item(ctx=False)
    r = reading_of(unread, summarize(unread))
    assert truth("swap", r) is None and truth("cctp", r) is None and truth("spam", r) is None
    # The amount and the two parties are still in the sentence.
    assert truth("over_100", r) is False and truth("to_wallet", r) is True

    nobody = item(contracts={})
    r = reading_of(nobody, summarize(nobody))
    assert truth("to_wallet", r) is None and truth("direct_payment", r) is None

    undirected = item(selector="0xdeadbeef",
                      topics=["0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036"])
    r = reading_of(undirected, summarize(undirected))
    assert truth("bridge", r) is True
    assert truth("bridge_out", r) is None and truth("bridge_in", r) is None
