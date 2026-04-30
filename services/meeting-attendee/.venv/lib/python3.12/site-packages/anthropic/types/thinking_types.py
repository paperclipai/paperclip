# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel
from .capability_support import CapabilitySupport

__all__ = ["ThinkingTypes"]


class ThinkingTypes(BaseModel):
    """Supported thinking type configurations."""

    adaptive: CapabilitySupport
    """Whether the model supports thinking with type 'adaptive' (auto)."""

    enabled: CapabilitySupport
    """Whether the model supports thinking with type 'enabled'."""
