import pytest

from finetune.blend import blend


def test_blend_moves_each_weight_alpha_of_the_way_to_the_fine_tune():
    got = blend({"a": 1.0, "b": -2.0}, {"a": 3.0, "b": 2.0}, 0.25)
    assert got == {"a": 1.5, "b": -1.0}


def test_alpha_one_is_the_fine_tune_and_zero_the_base():
    assert blend({"a": 1.0}, {"a": 3.0}, 1.0) == {"a": 3.0}
    assert blend({"a": 1.0}, {"a": 3.0}, 0.0) == {"a": 1.0}


def test_mismatched_checkpoints_are_refused():
    with pytest.raises(ValueError, match="same weights"):
        blend({"a": 1.0}, {"b": 1.0}, 0.5)
    with pytest.raises(ValueError, match="alpha"):
        blend({"a": 1.0}, {"a": 1.0}, 1.5)
