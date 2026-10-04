import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from capture import load  # noqa: E402

from finetune import bench, replay  # noqa: E402
from finetune.questions import NONSENSE_TRAIN, normalize, phrasings  # noqa: E402
from radar.summarize import summarize  # noqa: E402


def test_the_benchmark_is_big_and_english():
    assert len(bench.QUESTIONS) >= 60
    assert all(q.text.isascii() for q in bench.QUESTIONS)
    assert len({normalize(q.text) for q in bench.QUESTIONS}) == len(bench.QUESTIONS)


def test_new_questions_were_never_trained_or_replayed():
    trained = {normalize(p.text) for p in phrasings() if p.split == "train"}
    replayed = {normalize(q) for q in replay.QUESTIONS} | {normalize(t) for t in NONSENSE_TRAIN}
    for q in bench.QUESTIONS:
        assert normalize(q.text) not in trained | replayed, q.text


def test_new_questions_are_new():
    # Written after training and before measuring: none repeats eval.py or the held-out bank.
    import eval as bench_eval
    old = {normalize(q) for q, _ in bench_eval.QUESTIONS} | {normalize(p.text) for p in phrasings()}
    for q in bench.QUESTIONS:
        if q.origin == "new":
            assert normalize(q.text) not in old, q.text


def test_every_truth_runs_on_the_fixture_and_decides_most_transfers():
    rows = [(it, summarize(it)) for it in load()]
    for q in bench.QUESTIONS:
        got = [q.truth(it, s) for it, s in rows]
        assert all(v in (True, False, None) for v in got), q.text
        assert sum(v is not None for v in got) >= len(rows) // 2, q.text


def test_each_question_says_whether_its_concept_was_taught():
    assert {q.taught for q in bench.QUESTIONS} == {True, False}
    assert {q.origin for q in bench.QUESTIONS} == {"eval", "new"}
