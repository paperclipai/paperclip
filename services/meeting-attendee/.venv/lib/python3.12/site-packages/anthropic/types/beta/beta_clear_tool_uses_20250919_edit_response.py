# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaClearToolUses20250919EditResponse"]


class BetaClearToolUses20250919EditResponse(BaseModel):
    cleared_input_tokens: int
    """Number of input tokens cleared by this edit."""

    cleared_tool_uses: int
    """Number of tool uses that were cleared."""

    type: Literal["clear_tool_uses_20250919"]
    """The type of context management edit applied."""
