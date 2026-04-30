# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ..._models import BaseModel
from .beta_capability_support import BetaCapabilitySupport

__all__ = ["BetaThinkingTypes"]


class BetaThinkingTypes(BaseModel):
    """Supported thinking type configurations."""

    adaptive: BetaCapabilitySupport
    """Whether the model supports thinking with type 'adaptive' (auto)."""

    enabled: BetaCapabilitySupport
    """Whether the model supports thinking with type 'enabled'."""
