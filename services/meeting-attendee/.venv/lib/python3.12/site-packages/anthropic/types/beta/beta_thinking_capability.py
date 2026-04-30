# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ..._models import BaseModel
from .beta_thinking_types import BetaThinkingTypes

__all__ = ["BetaThinkingCapability"]


class BetaThinkingCapability(BaseModel):
    """Thinking capability details."""

    supported: bool
    """Whether this capability is supported by the model."""

    types: BetaThinkingTypes
    """Supported thinking type configurations."""
