"""Phrases that mark text as an attempt to instruct the model.

A decision model reads whatever it is given literally, so a viewer's question
that says "ignore previous rules" is simply more text unless it is caught
before it gets there.  The gate refuses such questions on their wording
(gate.inspect); the check is deterministic and nothing is delegated to the
model.  Transfer shapes need no such check: they are built entirely from fixed
phrases in summarize.py, with no chain-supplied text in them.
"""
from __future__ import annotations

import re

# Phrases that only ever appear in an injection attempt, never in a real question.
_INJECTION = re.compile(
    r"(ignore\s+(all\s+)?previous|disregard\s+(the\s+)?above|system\s*:|"
    r"pre-?approved|override|you\s+must\s+(allow|answer)|new\s+instructions)",
    re.IGNORECASE,
)
