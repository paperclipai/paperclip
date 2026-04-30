# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from ..._models import BaseModel
from .beta_capability_support import BetaCapabilitySupport

__all__ = ["BetaEffortCapability"]


class BetaEffortCapability(BaseModel):
    """Effort (reasoning_effort) capability details."""

    high: BetaCapabilitySupport
    """Whether the model supports high effort level."""

    low: BetaCapabilitySupport
    """Whether the model supports low effort level."""

    max: BetaCapabilitySupport
    """Whether the model supports max effort level."""

    medium: BetaCapabilitySupport
    """Whether the model supports medium effort level."""

    supported: bool
    """Whether this capability is supported by the model."""

    xhigh: Optional[BetaCapabilitySupport] = None
    """Indicates whether a capability is supported."""
