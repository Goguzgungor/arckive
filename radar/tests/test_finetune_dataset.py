import json

import pytest

from finetune import dataset, synth
from finetune.questions import NONSENSE_TRAIN, TOPICS, forbidden, normalize, phrasings, reading_of, truth
from radar.classify import LANE_QUESTION, LANES, RULE_PREFIX
from radar.summarize import summarize


@pytest.fixture(scope="module")
def rows():
    return dataset.build(synth.items())


def _questions(rows):
    for split, part in rows.items():
        for row in part:
            for qid, q in row["questions"].items():
                yield split, row, qid, q


def test_rows_only_ask_training_phrasings_nonsense_and_the_lane(rows):
    allowed = {p.text for p in phrasings() if p.split == "train"} | set(NONSENSE_TRAIN)
    for _, _, qid, q in _questions(rows):
        if qid == "lane":
            assert q == LANE_QUESTION
        else:
            assert q["type"] == "noul" and q["instructions"].startswith(RULE_PREFIX)
            assert q["instructions"][len(RULE_PREFIX):] in allowed


def test_no_benchmark_question_leaks(rows):
    banned = forbidden()
    for _, _, qid, q in _questions(rows):
        if qid != "lane":
            assert normalize(q["instructions"]) not in banned
            assert normalize(q["instructions"][len(RULE_PREFIX):]) not in banned


def test_held_out_topics_never_appear(rows):
    held = {k for k, t in TOPICS.items() if t.held_out}
    assert held
    for _, _, qid, _ in _questions(rows):
        assert qid.split(".")[0] not in held


def test_validation_states_are_disjoint_from_training(rows):
    train = {r["state"] for r in rows["train"]}
    val = {r["state"] for r in rows["val"]}
    assert val and not train & val


def test_labels_follow_the_story(rows):
    readings = {}
    for it in synth.items():
        s = summarize(it)
        readings[s["story"]] = reading_of(it, s)
    for _, row, qid, _ in _questions(rows):
        topic = qid.split(".")[0]
        p = row["gold"][qid]["probabilities"]
        if qid == "lane":
            assert set(p) == set(LANES) and abs(sum(p.values()) - 1) < 1e-9
            continue
        yes = p["true"] > p["false"]
        assert abs(p["true"] + p["false"] - 1) < 1e-9 and max(p.values()) == pytest.approx(0.95)
        if topic == "nonsense":
            assert not yes
        else:
            assert yes == truth(topic, readings[row["state"]])


def test_lane_rows_carry_the_fact_reading(rows):
    import eval as bench
    lanes = {}
    for it in synth.items():
        s = summarize(it)
        if not s["ruled"] and bench.reading(s) is not None:
            lanes[s["shape"]] = bench.reading(s)
    seen = [r for part in rows.values() for r in part if "lane" in r["questions"]]
    assert seen
    for r in seen:
        p = r["gold"]["lane"]["probabilities"]
        assert max(p, key=p.get) == lanes[r["state"]]


def test_nonsense_is_at_most_five_percent(rows):
    qids = [qid for _, _, qid, _ in _questions(rows) if qid != "lane"]
    nonsense = sum(q.startswith("nonsense.") for q in qids)
    assert 0 < nonsense <= 0.05 * (len(qids) - nonsense) + 1


def test_unreadable_transfers_only_get_amount_and_party_questions():
    facts_topics = {"swap", "bridge", "bridge_out", "bridge_in", "direct_payment", "signed", "defi", "vault",
                    "lending", "wrap", "cctp", "relay"}
    only = dataset.build([it for it, name in synth.labelled() if name == "unreadable"])
    unread = [r for part in only.values() for r in part if "could not be read" in r["state"]]
    assert unread
    for r in unread:
        for qid in r["questions"]:
            assert qid.split(".")[0] not in facts_topics, (qid, r["state"])


def test_the_benchmark_fixture_is_refused(tmp_path):
    from capture import FIXTURE
    with pytest.raises(SystemExit, match="benchmark"):
        dataset.main(["--capture", str(FIXTURE), "--out", str(tmp_path)])


def test_main_writes_the_trainer_format(tmp_path):
    capture = tmp_path / "cap.json"
    capture.write_text(json.dumps({"items": [], "txs": {}}))
    assert dataset.main(["--capture", str(capture), "--out", str(tmp_path / "out")]) == 0
    for name in ("train.jsonl", "val.jsonl", "stats.json", "audit.md"):
        assert (tmp_path / "out" / name).exists()
    first = json.loads((tmp_path / "out" / "train.jsonl").read_text().splitlines()[0])
    assert set(first) == {"state", "questions", "gold"} and set(first["gold"]) <= set(first["questions"])
    assert (tmp_path / "out" / "audit.md").read_text().count("\n- ") >= 60


def test_a_story_lives_on_the_same_side_as_its_shape(rows):
    shape_of = {}
    for it in synth.items():
        s = summarize(it)
        shape_of[s["story"]] = s["shape"]
        shape_of[s["shape"]] = s["shape"]
    for split, part in rows.items():
        for r in part:
            assert dataset.is_val(shape_of[r["state"]]) == (split == "val"), r["state"]


def test_the_majority_answer_is_held_to_a_multiple_of_the_minority(rows):
    counts = {}
    for part in rows.values():
        for r in part:
            for qid, gold in r["gold"].items():
                topic = qid.split(".")[0]
                if qid == "lane" or topic == "nonsense":
                    continue
                p = gold["probabilities"]
                counts.setdefault(topic, [0, 0])[p["true"] > p["false"]] += 1
    for topic, (no, yes) in counts.items():
        cap = max(dataset.MAJORITY_FLOOR, dataset.MAJORITY_RATIO * min(no, yes) // dataset.PHRASINGS_EACH)
        assert max(no, yes) <= cap * dataset.PHRASINGS_EACH, (topic, yes, no)
