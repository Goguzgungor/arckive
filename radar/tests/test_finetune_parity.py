from finetune.parity import compare

QUESTIONS = {"lane": {"type": "choice"}, "q": {"type": "noul"}}


def test_compare_counts_lane_agreement_and_the_largest_gap():
    ours = {"lane": {"choice": "swap", "probabilities": {"swap": 0.90, "bridge": 0.10}}, "q": {"noul": 0.70}}
    served = {"lane": {"choice": "swap", "probabilities": {"swap": 0.88, "bridge": 0.12}}, "q": {"noul": 0.735}}
    lanes, agree, gap = compare(QUESTIONS, ours, served)
    assert (lanes, agree) == (1, 1) and abs(gap - 0.035) < 1e-9


def test_a_different_lane_is_a_disagreement():
    ours = {"lane": {"choice": "swap", "probabilities": {"swap": 0.51, "bridge": 0.49}}}
    served = {"lane": {"choice": "bridge", "probabilities": {"swap": 0.49, "bridge": 0.51}}}
    assert compare({"lane": {"type": "choice"}}, ours, served)[:2] == (1, 0)
