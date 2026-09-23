from radar.gate import MIN_SEPARATION, PROBES, separation, threshold


def test_a_yes_line_sits_between_the_probes_in_log_odds():
    # Symmetric answers put the line at 0.5 either way.
    assert threshold([0.0] * 12 + [1.0] * 12) == 0.5
    # Answers crowded near zero: the line follows them down instead of
    # sitting at 0.2, above every yes the question gives.
    assert threshold([0.01] * 18 + [0.39] * 6) == 0.0744


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


def test_the_line_never_reaches_the_floor_or_the_ceiling():
    # One yes among answers at zero: at 0.0 every row would be highlighted.
    assert threshold([0.0] * 47 + [0.9]) == 0.01
    assert threshold([1.0] * 47 + [0.0]) == 0.99


def test_every_topic_has_two_probes():
    # threshold() sets the most extreme probe aside, so a topic with a single
    # probe would get its yes line from the noes.
    from radar.signatures import FACT_PHRASE, STORY_PHRASE, FACTORY_NAMES, _PROTOCOL_RULES
    phrases = {STORY_PHRASE[f] for f in FACT_PHRASE} | {"zero USDC", "could not be read", "plain direct transfer"}
    protocols = {name for name, _, _ in _PROTOCOL_RULES} | set(FACTORY_NAMES.values())
    for phrase in phrases:
        assert sum(phrase in p for p in PROBES) >= 2, phrase
    for name in protocols:
        assert sum(f"Protocol: {name}." in p for p in PROBES) >= 2, name
