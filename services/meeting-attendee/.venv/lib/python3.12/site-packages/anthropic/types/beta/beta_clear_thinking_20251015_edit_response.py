# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaClearThinking20251015EditResponse"]


class BetaClearThinking20251015EditResponse(BaseModel):
    cleared_input_tokens: int
    """Number of input tokens cleared by this edit."""

    cleared_thinking_turns: int
    """Number of thinking turns that were cleared."""

    type: Literal["clear_thinking_20251015"]
    """The type of context management edit applied."""
