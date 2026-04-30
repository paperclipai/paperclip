# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel
from .thinking_types import ThinkingTypes

__all__ = ["ThinkingCapability"]


class ThinkingCapability(BaseModel):
    """Thinking capability details."""

    supported: bool
    """Whether this capability is supported by the model."""

    types: ThinkingTypes
    """Supported thinking type configurations."""
