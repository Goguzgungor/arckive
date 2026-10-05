import math

from finetune.trainlib import clamp, improved, sha256_file, val_metrics


def test_clamp_reaches_nested_temperatures():
    fitted = {"temperature": {"choice": 0.2, "noul": 7.0, "score": 1.3}, "temperature_by_options": {"choice:8": 0.1}}
    assert clamp(fitted, 0.5, 5.0) == {"temperature": {"choice": 0.5, "noul": 5.0, "score": 1.3},
                                       "temperature_by_options": {"choice:8": 0.5}}


def test_val_metrics_scores_cross_entropy_and_accuracy():
    records = [("noul", [0.0, 2.0], [0.05, 0.95], 2), ("choice", [3.0, 0.0, 0.0], [0.0, 1.0, 0.0], 3)]
    m = val_metrics(records)
    assert m["n"] == 2 and m["accuracy"] == 0.5
    first = -(0.05 * math.log(1 / (1 + math.e ** 2)) + 0.95 * math.log(math.e ** 2 / (1 + math.e ** 2)))
    second = -math.log(1 / (math.e ** 3 + 2))
    assert math.isclose(m["ce"], (first + second) / 2, rel_tol=1e-9)


def test_only_a_lower_validation_loss_counts_as_better():
    assert improved([], {"ce": 0.5})
    assert improved([{"ce": 0.5}], {"ce": 0.4})
    assert not improved([{"ce": 0.5}, {"ce": 0.4}], {"ce": 0.45})


def test_sha256_file(tmp_path):
    f = tmp_path / "x"
    f.write_bytes(b"abc")
    assert sha256_file(f) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def test_clamp_reaches_per_type_lists():
    # laya stores the per-type temperatures as a list (one per question type).
    assert clamp({"temperature": [0.1, 1.0, 9.0]}, 0.5, 5.0) == {"temperature": [0.5, 1.0, 5.0]}


def test_only_types_with_enough_validation_are_refitted():
    from finetune.trainlib import merge_temperatures

    qtypes = {"choice": 0, "score": 1, "noul": 2}
    base = {"temperature": [1.0, 1.0, 1.0], "temperature_by_options": {"choice:6-10": 1.4}}
    fitted = {"temperature": [0.6, 1.0, 1.3], "temperature_by_options": {"choice:6-10": 0.7, "noul:2": 1.25}}
    got = merge_temperatures(base, fitted, {"choice": 40, "noul": 3000}, qtypes, min_n=500)
    # A few dozen lane rows cannot carry a fit the radar gates on; the base's stays.
    assert got == {"temperature": [1.0, 1.0, 1.3], "temperature_by_options": {"choice:6-10": 1.4, "noul:2": 1.25}}
