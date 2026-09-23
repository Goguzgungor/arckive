"""Normalise attacker-controlled chain-supplied text before it reaches the model.

Asset codes, memos and home domains are written by whoever issued the asset or
sent the payment.  A decision model reads them literally, so a memo saying
"IGNORE PREVIOUS RULES" is simply more text unless we strip it of its power
first.  Everything here is deterministic; nothing is delegated to the model.
"""
from __future__ import annotations

import re
import unicodedata

# Zero-width and bidi control characters used to hide or reorder text.
_INVISIBLE = re.compile(r"[​-‏‪-‮⁠-⁯﻿]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_WHITESPACE = re.compile(r"\s+")

# Phrases that only ever appear in an injection attempt, never in a real memo.
_INJECTION = re.compile(
    r"(ignore\s+(all\s+)?previous|disregard\s+(the\s+)?above|system\s*:|"
    r"pre-?approved|override|you\s+must\s+(allow|answer)|new\s+instructions)",
    re.IGNORECASE,
)

MAX_MEMO = 64
MAX_CODE = 12


def _strip(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = _INVISIBLE.sub("", text)
    text = _CONTROL.sub(" ", text)
    return _WHITESPACE.sub(" ", text).strip()


def is_homoglyph(code: str) -> bool:
    """True when an asset code mixes scripts or leaves ASCII entirely.

    `USDC` written with a Cyrillic `С` normalises to a different string than
    the ASCII original, so a pure string comparison misses it.  Checking the
    characters directly does not.
    """
    return any(ord(ch) > 127 for ch in code)


def clean_code(code: str) -> str:
    return _strip(code)[:MAX_CODE] or "?"


def clean_memo(memo: str | None) -> tuple[str, bool]:
    """Return a safe memo and whether it looked like an injection attempt."""
    if not memo:
        return "", False
    flagged = bool(_INJECTION.search(memo))
    text = _strip(memo)[:MAX_MEMO]
    if flagged:
        # Keep the operation visible but deny the text any instructional force.
        return "[flagged: instruction-like memo]", True
    return text, False


def short_account(account: str | None) -> str:
    if not account:
        return "?"
    account = _strip(account)
    return f"{account[:4]}..{account[-4:]}" if len(account) > 10 else account
