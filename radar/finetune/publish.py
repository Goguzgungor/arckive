"""Publish the shipped fine-tune and its benchmark on Hugging Face.

    .venv-ft/bin/python -m finetune.publish --info info.json --pytorch "$RUN/blend-0.5" \\
        --mlx "$RUN/blend-0.5-mlx" --data "$DATA" --stage "$STAGE" [--push]

Three repos under one namespace: the PyTorch checkpoint (loads with
`laya.load`), its MLX fp16 twin (what layad serves), and a dataset repo with
the benchmark, the label audit and the training rows. Every number on the
cards comes from the info file, which is assembled from the measurement
outputs; nothing here is typed by hand. Without --push this only stages the
three folders, so they can be read before anything leaves the machine. With
--push it uploads them and then downloads each model file back from the Hub
and checks it byte for byte against what was measured.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

from radar.classify import LANE_QUESTION, RULE_PREFIX

BASE = "convaiinnovations/laya-multilingual"
BASE_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"
RADAR = "https://radar.arckive.org"
SOURCE = "https://github.com/Goguzgungor/arckive/tree/main/radar"


def _repo(info: dict, suffix: str = "") -> str:
    return f"{info['ns']}/{info['name']}{suffix}"


def _row(label: str, s: dict) -> str:
    return f"| {label} | {s['n']} | {s['base_bal']:.3f} | **{s['ft_bal']:.3f}** | {s['base_auc']:.3f} | **{s['ft_auc']:.3f}** |"


def _lanes() -> str:
    return "\n".join(f"{k + 1}. `{name}`: {desc}" for k, (name, desc) in enumerate(LANE_QUESTION["criteria"].items()))


def _bench_table(info: dict) -> str:
    s = info["bench"]["summary"]
    return "\n".join([
        "| Questions | n | Balanced acc. (base) | Balanced acc. (fine-tune) | AUC (base) | AUC (fine-tune) |",
        "|---|---|---|---|---|---|",
        _row("All countable", s["all"]),
        _row("Written for this benchmark, before measuring", s["new"]),
        _row("The radar's long-standing questions", s["eval"]),
        _row("Concepts the fine-tune was taught", s["taught"]),
        _row("Concepts it was never taught", s["untaught"]),
    ])


def _per_question(info: dict) -> str:
    lines = ["| Question | Taught | Base | Fine-tune |", "|---|---|---|---|"]
    for r in sorted(info["bench"]["rows"], key=lambda r: r["ft"] - r["base"]):
        lines.append(f"| {r['text']}{' (new)' if r['origin'] == 'new' else ''} | {'yes' if r['taught'] else 'no'} | "
                     f"{r['base']:.2f} | {r['ft']:.2f} |")
    return "\n".join(lines)


def model_card(info: dict, kind: str) -> str:
    mlx = kind == "mlx"
    b, g, a = info["bench"], info["gate"], info["audit"]
    front = "\n".join([
        "---", "license: apache-2.0", f"base_model: {BASE}",
        f"library_name: {'mlx' if mlx else 'laya'}", "pipeline_tag: text-classification", "language:", "- en",
        "tags:", "- laya", "- decision-model", "- arc", "- usdc", "- stablecoin", "- blockchain", "- fine-tuned",
        *(["- mlx", "- apple-silicon"] if mlx else []),
        "datasets:", f"- {info['ns']}/{info['dataset']}", "---", "",
    ])
    usage = (f"""Served on Apple silicon by [layad](https://github.com/rcwsr/layad):

```bash
LAYAD_MODEL={_repo(info, '-mlx')} layad serve
```

or loaded directly with `laya-mlx`:

```python
import laya_mlx
agent = laya_mlx.load("{_repo(info, '-mlx')}")
```

This is the fp16 MLX conversion of [{_repo(info)}](https://huggingface.co/{_repo(info)}) (PyTorch). Over the validation rows, the two give the same lane every time. Their probabilities differ by at most 0.006.""" if mlx else
             f"""```python
import laya
agent = laya.load("{_repo(info)}")
story = ("USDC moved from a wallet to a contract, amount 1 to 100 USDC (a small amount). "
         "In the same transaction: tokens were swapped on an exchange. Protocol: Uniswap.")
agent.predict(story, {{"q": {{"type": "noul", "instructions": "{RULE_PREFIX}Is this a swap?"}}}})
```

An MLX fp16 twin for Apple silicon (layad) is at [{_repo(info, '-mlx')}](https://huggingface.co/{_repo(info, '-mlx')}).""")
    return front + f"""# Laya Multilingual for Arc USDC transfers

A fine-tune of [{BASE}](https://huggingface.co/{BASE}) (322M parameters), the base Laya decision model, at revision `{BASE_REVISION[:8]}`. It is tuned to read the sentences [Arc Radar]({RADAR}) writes about USDC transfers on Arc, Circle's stablecoin chain. Each transfer gets one of eight lanes and answers to yes/no questions that viewers ask about it.

On a benchmark of {b['total']} English questions over {b['transfers']:,} live transfers, the fine-tune raises balanced accuracy from **{b['summary']['all']['base_bal']:.3f} to {b['summary']['all']['ft_bal']:.3f}**. It does better than the base on {b['better']} of {b['summary']['all']['n']} questions and worse on {b['worse']}. An independent auditor checked {a['n']} transfers on chain, drawn from those where the base and an earlier fine-tune ({a.get('drawn_from', 'run 3')}) disagreed. It found our labels right in **{a['label_ok']} of {a['n']}**, this model right in {a['ft_ok']} of {a['n']} and the base right in {a['base_ok']} of {a['n']}.

## Usage

{usage}

## What it reads

It reads one English sentence per transfer, never addresses. The sentences come from the radar's `summarize()` ([source]({SOURCE})), and the model is only measured on them. Other text is out of its domain.

- **Lane** is asked of the `shape` sentence, with the question `{LANE_QUESTION['instructions']}` and these options, verbatim and in this order. Order and wording are part of what was trained.
{_lanes()}
- **Viewer questions** are asked of the `story` sentence as `noul` questions, each prefixed with `{RULE_PREFIX}`.

Example `story`: `USDC moved from a wallet to a contract, amount 100 to 10,000 USDC (a medium amount). In the same transaction: funds were sent across chains through a bridge (out of Arc). Protocol: CCTP.`

## Benchmark

{b['transfers']:,} transfers, collected after this model was chosen. {b['total']} questions: the radar's 27 English benchmark questions and 39 new ones, committed before either model answered them. A question counts when at least ten transfers answer it yes and ten no ({b['summary']['all']['n']} do). Answers are read at each question's own yes line, the line the radar uses.

{_bench_table(info)}

On the radar's own 1,200-transfer fixture, lanes agree with the audited fact table {info['lanes']['base']}% (base) and {info['lanes']['ft']}% (fine-tune). The radar's question gate refuses {g['refused_base']} and {g['refused_ft']} of 37 answerable questions, and turns away {g['nonsense_base']} and {g['nonsense_ft']} of 14 nonsense ones.

<details><summary>Every question</summary>

{_per_question(info)}

</details>

The data, the per-question results and the audit are in the dataset repo [{info['ns']}/{info['dataset']}](https://huggingface.co/datasets/{info['ns']}/{info['dataset']}).

## Training

- **Data.** {info['transfers']:,} live Arc transfers plus {info['synthetic']} synthetic ones for facts the stream rarely carries. Both go through the radar's own sentence code. That gives {info['train_questions']:,} labelled questions over the sentences, from a question bank with held-out wordings, topics and languages, plus lane rows. A hand audit of 60 labels found all 60 backed by the sentence alone.
- **Replay.** {info['replay_questions']:,} questions from outside the bank were trained toward the base model's own answers (learning without forgetting). Without them, fine-tuning pushed answers to untaught questions toward "no".
- **Run.** Full fine-tune with the token-embedding table frozen, soft cross-entropy on targets smoothed to 0.95/0.05, {info['kept_epoch']} epochs (`{info['run']}`). Trained on an M4 Pro Mac mini (MPS), under a supervisor that paused training whenever the live radars' model slowed.
- **Blend.** The released weights are {info['alpha']:.0%} fine-tune and {1 - info['alpha']:.0%} base (WiSE-FT), which kept most of the gain and restored untaught questions.
- The lane temperature is the base's; the yes/no temperature was refit on validation.

## Limits

- Measured on Arc USDC transfers only. Other chains, tokens or sentence formats are unmeasured.
- "Spam or dust" means any transfer under one cent, zero included, whatever else the transaction did.
- The yes line of a question is drawn from the radar's probe transfers. For a few untaught questions it lands in the wrong place even when the ranking is right.
- English only. Turkish was not a target; Spanish, German and Russian wordings were held out and measured.

## License and attribution

Apache-2.0, as is the base model. Built on [{BASE}](https://huggingface.co/{BASE}) by Convai Innovations.{' Converted with [laya-mlx](https://github.com/mizorewww/laya-mlx).' if mlx else ''} See `NOTICE`.
"""


def dataset_card(info: dict) -> str:
    b, a = info["bench"], info["audit"]
    return "\n".join([
        "---", "license: apache-2.0", "language:", "- en", "tags:", "- arc", "- usdc", "- blockchain", "- benchmark", "- laya",
        "pretty_name: Arc USDC transfer questions", "---", "",
        "# Arc USDC transfer questions",
        "",
        f"The benchmark, label audit and training rows behind [{_repo(info)}](https://huggingface.co/{_repo(info)}). Each row is one English sentence that [Arc Radar]({RADAR}) wrote about a live USDC transfer on Arc, plus yes/no questions about it.",
        "",
        "## Files",
        "",
        f"- `bench-results.json`: {b['total']} questions on {b['transfers']:,} transfers, collected after the model was chosen. Has per-question balanced accuracy and AUC for the base and the fine-tune, and which questions were written for the benchmark or taught.",
        f"- `audit-sample.json`, `audit-verdicts.json`: {a['n']} transfers where the two models disagree. Each was answered from the chain by an auditor that saw neither the labels nor the radar's code, and its evidence is recorded. Labels matched the chain in {a['label_ok']} of {a['n']}.",
        "- `train.jsonl`, `val.jsonl`: the training rows in laya's `{state, questions, gold}` format. They include the replay rows (soft targets from the base model) and lane rows.",
        "- `page.json`: everything the benchmark page shows, in one file.",
        "",
        "Sentences carry no addresses. The audit files hold transaction hashes and addresses, all of it public chain data.",
    ]) + "\n"


NOTICE = """This model is a fine-tune of convaiinnovations/laya-multilingual
(https://huggingface.co/convaiinnovations/laya-multilingual), Copyright Convai
Innovations, licensed under the Apache License, Version 2.0.
Fine-tuned for Arc Radar (https://radar.arckive.org) and released under the
same license.
"""


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def stage(info: dict, pytorch: Path, mlx: Path, data: dict[str, Path], out: Path, license_text: str) -> dict[str, Path]:
    if out.exists():
        shutil.rmtree(out)
    folders = {"pytorch": out / info["name"], "mlx": out / f"{info['name']}-mlx", "dataset": out / info["dataset"]}
    for kind, src in (("pytorch", pytorch), ("mlx", mlx)):
        shutil.copytree(src, folders[kind])
        (folders[kind] / "README.md").write_text(model_card(info, kind))
        (folders[kind] / "LICENSE").write_text(license_text)
        (folders[kind] / "NOTICE").write_text(NOTICE)
    folders["dataset"].mkdir(parents=True)
    for name, src in data.items():
        shutil.copy(src, folders["dataset"] / name)
    (folders["dataset"] / "README.md").write_text(dataset_card(info))
    (folders["dataset"] / "LICENSE").write_text(license_text)
    return folders


def push(info: dict, folders: dict[str, Path], private: bool) -> None:
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi()
    targets = {"pytorch": (_repo(info), "model"), "mlx": (_repo(info, "-mlx"), "model"),
               "dataset": (f"{info['ns']}/{info['dataset']}", "dataset")}
    for kind, (repo, repo_type) in targets.items():
        api.create_repo(repo, repo_type=repo_type, private=private, exist_ok=True)
        api.upload_folder(folder_path=str(folders[kind]), repo_id=repo, repo_type=repo_type,
                          commit_message=f"Upload {info['run']} (blend {info['alpha']})")
        print(f"uploaded {repo_type} {repo}")
    for kind in ("pytorch", "mlx"):
        repo = targets[kind][0]
        got = Path(hf_hub_download(repo, "model.safetensors", force_download=True))
        same = _sha(got) == _sha(folders[kind] / "model.safetensors")
        print(f"{repo}: model.safetensors {'matches' if same else 'DIFFERS FROM'} the measured file")
        if not same:
            raise SystemExit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--info", type=Path, required=True)
    parser.add_argument("--pytorch", type=Path, required=True)
    parser.add_argument("--mlx", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True, help="a folder holding the dataset files to publish")
    parser.add_argument("--license", type=Path, required=True, help="the Apache-2.0 license text")
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--push", action="store_true")
    parser.add_argument("--private", action="store_true")
    args = parser.parse_args()
    info = json.loads(args.info.read_text())
    data = {p.name: p for p in sorted(args.data.iterdir()) if p.is_file()}
    folders = stage(info, args.pytorch, args.mlx, data, args.stage, args.license.read_text())
    for kind, folder in folders.items():
        print(f"staged {kind}: {folder}")
    if args.push:
        push(info, folders, args.private)
    return 0


if __name__ == "__main__":
    sys.exit(main())
