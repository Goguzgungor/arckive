from finetune import publish
from radar.classify import LANE_QUESTION, RULE_PREFIX

INFO = {
    "ns": "someone", "name": "laya-multilingual-arc", "dataset": "arc-usdc-laya-bench",
    "run": "laya-multilingual-arc-20261005-4", "alpha": 0.5, "kept_epoch": 3, "train_questions": 17806,
    "replay_questions": 5142, "transfers": 15000, "synthetic": 816,
    "bench": {"transfers": 20000, "total": 66, "summary": {
        "all": {"n": 59, "base_bal": 0.783, "ft_bal": 0.955, "base_auc": 0.878, "ft_auc": 0.978},
        "new": {"n": 36, "base_bal": 0.745, "ft_bal": 0.944, "base_auc": 0.85, "ft_auc": 0.97},
        "eval": {"n": 23, "base_bal": 0.843, "ft_bal": 0.972, "base_auc": 0.921, "ft_auc": 0.99},
        "taught": {"n": 38, "base_bal": 0.75, "ft_bal": 0.965, "base_auc": 0.846, "ft_auc": 0.988},
        "untaught": {"n": 21, "base_bal": 0.843, "ft_bal": 0.936, "base_auc": 0.935, "ft_auc": 0.959}},
        "rows": [{"text": "Is this a swap?", "origin": "eval", "taught": True, "base": 0.94, "ft": 1.0, "base_auc": 0.97, "ft_auc": 1.0, "yes": 10, "n": 20}],
        "better": 57, "worse": 1},
    "lanes": {"base": 99.8, "ft": 100.0}, "gate": {"refused_base": 0, "refused_ft": 0, "nonsense_base": 8, "nonsense_ft": 14},
    "audit": {"n": 51, "label_ok": 51, "ft_ok": 51, "base_ok": 0},
}


def test_the_model_card_says_what_it_is_built_on_and_what_it_reads():
    card = publish.model_card(INFO, "pytorch")
    assert card.startswith("---\n") and "license: apache-2.0" in card
    assert "base_model: convaiinnovations/laya-multilingual" in card
    assert "datasets:\n- someone/arc-usdc-laya-bench" in card
    assert RULE_PREFIX in card
    # The lane question is part of what was trained: its options appear verbatim and in order.
    positions = [card.index(f"`{k}`") for k in LANE_QUESTION["criteria"]]
    assert positions == sorted(positions)
    assert "0.783" in card and "0.955" in card and "51 of 51" in card
    assert "TODO" not in card and "TBD" not in card


def test_the_mlx_card_points_at_layad_and_the_pytorch_twin():
    card = publish.model_card(INFO, "mlx")
    assert "library_name: mlx" in card and "LAYAD_MODEL=someone/laya-multilingual-arc-mlx" in card
    assert "someone/laya-multilingual-arc)" in card


def test_the_dataset_card_names_its_files_and_licence():
    card = publish.dataset_card(INFO)
    assert card.startswith("---\n") and "license: apache-2.0" in card
    for name in ("bench-results.json", "audit-verdicts.json", "train.jsonl"):
        assert name in card
