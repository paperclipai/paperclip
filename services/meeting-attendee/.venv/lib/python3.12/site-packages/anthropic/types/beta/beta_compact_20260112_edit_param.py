# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_input_tokens_trigger_param import BetaInputTokensTriggerParam

__all__ = ["BetaCompact20260112EditParam"]


class BetaCompact20260112EditParam(TypedDict, total=False):
    """
    Automatically compact older context when reaching the configured trigger threshold.
    """

    type: Required[Literal["compact_20260112"]]

    instructions: Optional[str]
    """Additional instructions for summarization."""

    pause_after_compaction: bool
    """Whether to pause after compaction and return the compaction block to the user."""

    trigger: Optional[BetaInputTokensTriggerParam]
    """When to trigger compaction. Defaults to 150000 input tokens."""
