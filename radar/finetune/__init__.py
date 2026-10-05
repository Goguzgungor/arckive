"""Fine-tuning Laya for Arc Radar: the data, the run, and the checks around it.

Everything here except train.py and parity.py runs in the radar's own venv,
with no torch; those two run in .venv-ft. See
docs/superpowers/specs/2026-10-04-radar-laya-finetune-design.md.
"""
