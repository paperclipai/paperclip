# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from ..._types import SequenceNotStr
from .beta_tool_uses_keep_param import BetaToolUsesKeepParam
from .beta_tool_uses_trigger_param import BetaToolUsesTriggerParam
from .beta_input_tokens_trigger_param import BetaInputTokensTriggerParam
from .beta_input_tokens_clear_at_least_param import BetaInputTokensClearAtLeastParam

__all__ = ["BetaClearToolUses20250919EditParam", "Trigger"]

Trigger: TypeAlias = Union[BetaInputTokensTriggerParam, BetaToolUsesTriggerParam]


class BetaClearToolUses20250919EditParam(TypedDict, total=False):
    type: Required[Literal["clear_tool_uses_20250919"]]

    clear_at_least: Optional[BetaInputTokensClearAtLeastParam]
    """Minimum number of tokens that must be cleared when triggered.

    Context will only be modified if at least this many tokens can be removed.
    """

    clear_tool_inputs: Union[bool, SequenceNotStr[str], None]
    """Whether to clear all tool inputs (bool) or specific tool inputs to clear (list)"""

    exclude_tools: Optional[SequenceNotStr[str]]
    """Tool names whose uses are preserved from clearing"""

    keep: BetaToolUsesKeepParam
    """Number of tool uses to retain in the conversation"""

    trigger: Trigger
    """Condition that triggers the context management strategy"""
