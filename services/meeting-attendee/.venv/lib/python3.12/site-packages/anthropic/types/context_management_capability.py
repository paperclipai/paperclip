# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from .._models import BaseModel
from .capability_support import CapabilitySupport

__all__ = ["ContextManagementCapability"]


class ContextManagementCapability(BaseModel):
    """Context management capability details."""

    clear_thinking_20251015: Optional[CapabilitySupport] = None
    """Indicates whether a capability is supported."""

    clear_tool_uses_20250919: Optional[CapabilitySupport] = None
    """Indicates whether a capability is supported."""

    compact_20260112: Optional[CapabilitySupport] = None
    """Indicates whether a capability is supported."""

    supported: bool
    """Whether this capability is supported by the model."""
