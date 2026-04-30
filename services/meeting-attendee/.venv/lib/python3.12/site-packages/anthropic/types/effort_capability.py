# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from .._models import BaseModel
from .capability_support import CapabilitySupport

__all__ = ["EffortCapability"]


class EffortCapability(BaseModel):
    """Effort (reasoning_effort) capability details."""

    high: CapabilitySupport
    """Whether the model supports high effort level."""

    low: CapabilitySupport
    """Whether the model supports low effort level."""

    max: CapabilitySupport
    """Whether the model supports max effort level."""

    medium: CapabilitySupport
    """Whether the model supports medium effort level."""

    supported: bool
    """Whether this capability is supported by the model."""

    xhigh: Optional[CapabilitySupport] = None
    """Indicates whether a capability is supported."""
