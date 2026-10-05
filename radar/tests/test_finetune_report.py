from finetune.questions import Phrasing
from finetune.report import Score, balanced, verdicts


def test_balanced_accuracy_at_the_line():
    assert balanced([0.9, 0.8, 0.2], [0.1, 0.6], 0.5) == (2 / 3 + 1 / 2) / 2


def _s(bal):
    return Score(auc=bal, bal=bal, pos=20, neg=20)


ASKED = [
    Phrasing("swap", "a", "en", "heldout-phrasing"), Phrasing("swap", "b", "tr", "heldout-phrasing"),
    Phrasing("fee", "c", "en", "heldout-topic"), Phrasing("fee", "d", "tr", "heldout-topic"),
    Phrasing("swap", "e", "es", "heldout-language"),
]


def test_all_pass_when_phrasings_gain_and_nothing_else_drops():
    base = {"a": _s(0.70), "b": _s(0.70), "c": _s(0.80), "d": _s(0.70), "e": _s(0.70)}
    ft = {"a": _s(0.80), "b": _s(0.78), "c": _s(0.79), "d": _s(0.70), "e": _s(0.69)}
    assert all(ok for _, ok, _ in verdicts(base, ft, ASKED, stuck_ft=0))


def test_one_held_out_question_falling_more_than_five_points_fails():
    base = {"a": _s(0.70), "b": _s(0.70), "c": _s(0.80), "d": _s(0.70), "e": _s(0.70)}
    ft = {"a": _s(0.80), "b": _s(0.80), "c": _s(0.74), "d": _s(0.80), "e": _s(0.70)}
    failed = [name for name, ok, _ in verdicts(base, ft, ASKED, stuck_ft=0) if not ok]
    assert failed == ["no held-out topic question worse than base by more than 0.05"]


def test_uncountable_sets_and_stuck_rows_fail():
    base = {"a": None, "b": None, "c": _s(0.8), "d": _s(0.8), "e": _s(0.7)}
    ft = {"a": _s(0.9), "b": _s(0.9), "c": _s(0.8), "d": _s(0.8), "e": _s(0.7)}
    failed = {name for name, ok, _ in verdicts(base, ft, ASKED, stuck_ft=3) if not ok}
    assert "held-out phrasings gain at least 0.05" in failed
    assert "fine-tune leaves no row stuck on the test capture" in failed


def test_tally_skips_stuck_rows_undecided_truths_and_unkept_transfers():
    from dataclasses import replace

    from finetune.questions import Reading
    from finetune.report import tally

    big = Reading(readable=True, facts=frozenset(), amount=500.0, frm="wallet", to="wallet", protocol="",
                  direction="", plain=True)
    small = replace(big, amount=5.0)
    p = Phrasing("over_100", "Is this over 100 USDC?", "en", "train")
    readings = [big] * 12 + [small] * 12 + [big]
    answers = [{"stuck": False, "rules": {p.text: 0.9}}] * 12 + [{"stuck": False, "rules": {p.text: 0.2}}] * 12 \
        + [{"stuck": True, "rules": {}}]
    got = tally([p], readings, answers, {p.text: 0.5}, [True] * 25)[p.text]
    assert (got.pos, got.neg, got.bal, got.auc) == (12, 12, 1.0, 1.0)
    # Keep only half the yeses: below MIN_COUNT, so the phrasing is not countable.
    keep = [k % 2 == 0 for k in range(12)] + [True] * 13
    assert tally([p], readings, answers, {p.text: 0.5}, keep)[p.text] is None


def test_ask_batches_like_the_server_and_names_answers_by_phrasing(monkeypatch):
    import asyncio

    from finetune import report

    calls = []

    class FakeClassifier:
        def __init__(self, endpoint, token=""):
            pass

        async def probe(self, question):
            return [0.1, 0.9]

        async def classify(self, shapes, stories, rules):
            calls.append((len(stories), len(rules)))
            return [{"stuck": s == "stuck", "rules": {n: 0.7 for n in rules}} for s in stories]

        async def close(self):
            pass

    monkeypatch.setattr(report, "Classifier", FakeClassifier)
    asked = [Phrasing("swap", f"question {k}?", "en", "heldout-phrasing") for k in range(report.RULES_PER_CALL + 1)]
    summaries = [{"shape": "x", "story": "stuck" if k == 0 else f"s{k}"} for k in range(report.CHUNK + 1)]
    lines, answers = asyncio.run(report.ask("http://model", "", summaries, asked))
    assert set(lines) == {p.text for p in asked}
    assert len(answers) == len(summaries) and answers[0]["stuck"] and not answers[1]["stuck"]
    assert answers[1]["rules"] == {p.text: 0.7 for p in asked}
    # Two chunks of transfers, each asked in two groups of questions.
    assert calls == [(report.CHUNK, report.RULES_PER_CALL), (report.CHUNK, 1), (1, report.RULES_PER_CALL), (1, 1)]
