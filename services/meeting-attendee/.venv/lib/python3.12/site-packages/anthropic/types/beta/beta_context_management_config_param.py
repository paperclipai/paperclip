# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable
from typing_extensions import TypeAlias, TypedDict

from .beta_compact_20260112_edit_param import BetaCompact20260112EditParam
from .beta_clear_thinking_20251015_edit_param import BetaClearThinking20251015EditParam
from .beta_clear_tool_uses_20250919_edit_param import BetaClearToolUses20250919EditParam

__all__ = ["BetaContextManagementConfigParam", "Edit"]

Edit: TypeAlias = Union[
    BetaClearToolUses20250919EditParam, BetaClearThinking20251015EditParam, BetaCompact20260112EditParam
]


class BetaContextManagementConfigParam(TypedDict, total=False):
    edits: Iterable[Edit]
    """List of context management edits to apply"""
