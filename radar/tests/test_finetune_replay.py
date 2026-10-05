import asyncio
import json

from finetune import dataset, replay, synth
from finetune.questions import NONSENSE_TRAIN, forbidden, normalize, phrasings
from radar.classify import RULE_PREFIX
from radar.summarize import summarize


def test_replay_questions_share_no_text_with_the_bank_or_the_benchmark():
    taken = forbidden() | {normalize(p.text) for p in phrasings()} | {normalize(t) for t in NONSENSE_TRAIN}
    assert len(replay.QUESTIONS) >= 60
    for q in replay.QUESTIONS:
        assert normalize(q) not in taken, q


def test_replay_questions_avoid_every_taught_held_out_and_benchmark_concept():
    # Held-out topics must stay unseen in any form, and taught or benchmark
    # concepts answered with the base's weaker answers would fight the labels.
    for q in replay.QUESTIONS:
        words = q.lower()
        hits = [w for w in replay.AVOID if w in words]
        assert not hits, (q, hits)


def test_the_avoid_list_covers_every_held_out_topic_and_benchmark_concept():
    for word in ("fee", "commission", "smart account", "liquidity", "pool", "batch", "reward", "payout", "marketplace",
                 "nft", "spam", "uniswap", "aerodrome", "okx", "kyber", "1inch", "li.fi", "ücret", "ödül", "likidite",
                 "arbitrage", "test", "ethereum", "payroll", "salary", "swap", "bridge", "chain", "wallet", "contract"):
        assert word in replay.AVOID, word


def test_sampling_is_deterministic_and_bounded():
    stories = [f"story {k}" for k in range(50)]
    a = replay.sample(stories, seed=3)
    assert a == replay.sample(stories, seed=3)
    assert set(a) == set(stories)
    assert all(len(qs) == replay.EACH and len(set(qs)) == replay.EACH for qs in a.values())


def test_answers_are_asked_as_the_server_asks_and_kept_as_given(monkeypatch):
    seen = []

    async def fake_post(endpoint, token, states, question):
        seen.append((len(states), question))
        return [0.25 + 0.01 * k for k in range(len(states))]

    monkeypatch.setattr(replay, "_post", fake_post)
    picked = {f"s{k}": [replay.QUESTIONS[0]] for k in range(replay.CHUNK + 1)}
    got = asyncio.run(replay.answer("http://base", "", picked))
    assert got["s0"] == {replay.QUESTIONS[0]: 0.25}
    assert seen == [(replay.CHUNK, RULE_PREFIX + replay.QUESTIONS[0]), (1, RULE_PREFIX + replay.QUESTIONS[0])]


def test_replay_rows_carry_the_base_answer_as_a_soft_target(tmp_path):
    story = summarize(synth.items()[0])["story"]
    q = replay.QUESTIONS[0]
    rows = dataset.build(synth.items(), replay={story: {q: 0.3}})
    found = [(r, qid) for part in rows.values() for r in part if r["state"] == story
             for qid in r["questions"] if qid.startswith("replay.")]
    assert len(found) == 1
    r, qid = found[0]
    assert r["questions"][qid]["instructions"] == RULE_PREFIX + q
    assert r["gold"][qid]["probabilities"] == {"true": 0.3, "false": 0.7}


def test_the_cli_reads_a_replay_file(tmp_path):
    capture = tmp_path / "cap.json"
    capture.write_text(json.dumps({"items": [], "txs": {}}))
    story = summarize(synth.items()[0])["story"]
    answers = tmp_path / "replay.json"
    answers.write_text(json.dumps({story: {replay.QUESTIONS[1]: 0.8}}))
    assert dataset.main(["--capture", str(capture), "--out", str(tmp_path / "out"), "--replay", str(answers)]) == 0
    stats = json.loads((tmp_path / "out" / "stats.json").read_text())
    assert stats["replay_questions"] == 1
