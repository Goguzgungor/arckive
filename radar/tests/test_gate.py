from radar.gate import MIN_SEPARATION, PROBES, separation, threshold


def test_a_yes_line_sits_between_the_probes_in_log_odds():
    # Symmetric answers put the line at 0.5 either way.
    assert threshold([0.0] * 12 + [1.0] * 12) == 0.5
    # Answers crowded near zero: the line follows them down instead of
    # sitting at 0.2, above every yes the question gives.
    assert threshold([0.01] * 18 + [0.39] * 6) == 0.074


def test_one_odd_probe_does_not_move_the_line():
    usual = [0.02] * 17 + [0.35] * 6
    assert threshold(usual + [0.99]) == threshold(usual + [0.36])


def test_too_few_answers_fall_back_to_half():
    assert threshold([]) == 0.5
    assert threshold([0.1, 0.9]) == 0.5


def test_a_question_the_radar_can_answer_clears_the_bar():
    # Four probes of 35 took a fee; a question about fees separates them
    # enough to be asked, and a flat one does not.
    fee = [0.6 if i < 4 else 0.02 for i in range(len(PROBES))]
    assert separation(fee) >= MIN_SEPARATION
    assert separation([0.4] * len(PROBES)) < MIN_SEPARATION
