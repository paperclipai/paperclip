"""
clean_parser — reference

Binary contamination detector for local LLM output.

Returns 1.0 (clean) or 0.0 (contaminated) for a model-generated string.
Contamination categories (per reference RL-reward definition §4):
  1. think_leak   — <think>/<thinking>/<|thinking|> tags or closing variants
  2. tool_markup  — <tool_call>/<tool_response> XML leaked into content
  3. action_narration — "I will now…", "Let me…", "As an AI…", etc.

This is a metric today; if training is ever authorized (separate board gate),
it doubles as a reward signal for RLHF/DPO pipelines.
"""
from __future__ import annotations

import re

_THINK_RE = re.compile(
    r"</?think(?:ing)?>|<\|/?thinking\|>",
    re.IGNORECASE,
)

_TOOL_MARKUP_RE = re.compile(
    r"</?tool_(?:call|response)>",
    re.IGNORECASE,
)

_ACTION_NARRATION_RE = re.compile(
    r"\bI will now\b"
    r"|\bLet me\b"
    r"|\bI(?:'m| am) going to\b"
    r"|\bAs an AI\b"
    r"|\bAs a helpful\b",
    re.IGNORECASE,
)


def score(text: str) -> float:
    """Return 1.0 if clean, 0.0 if any contamination detected."""
    if not isinstance(text, str):
        return 0.0
    if _THINK_RE.search(text):
        return 0.0
    if _TOOL_MARKUP_RE.search(text):
        return 0.0
    if _ACTION_NARRATION_RE.search(text):
        return 0.0
    return 1.0


def explain(text: str) -> dict:
    """Return score + list of detected contamination types."""
    if not isinstance(text, str):
        return {"score": 0.0, "contamination_types": ["not_a_string"]}
    types: list[str] = []
    if _THINK_RE.search(text):
        types.append("think_leak")
    if _TOOL_MARKUP_RE.search(text):
        types.append("tool_markup")
    if _ACTION_NARRATION_RE.search(text):
        types.append("action_narration")
    return {"score": 1.0 if not types else 0.0, "contamination_types": types}
