# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel
from .effort_capability import EffortCapability
from .capability_support import CapabilitySupport
from .thinking_capability import ThinkingCapability
from .context_management_capability import ContextManagementCapability

__all__ = ["ModelCapabilities"]


class ModelCapabilities(BaseModel):
    """Model capability information."""

    batch: CapabilitySupport
    """Whether the model supports the Batch API."""

    citations: CapabilitySupport
    """Whether the model supports citation generation."""

    code_execution: CapabilitySupport
    """Whether the model supports code execution tools."""

    context_management: ContextManagementCapability
    """Context management support and available strategies."""

    effort: EffortCapability
    """Effort (reasoning_effort) support and available levels."""

    image_input: CapabilitySupport
    """Whether the model accepts image content blocks."""

    pdf_input: CapabilitySupport
    """Whether the model accepts PDF content blocks."""

    structured_outputs: CapabilitySupport
    """Whether the model supports structured output / JSON mode / strict tool schemas."""

    thinking: ThinkingCapability
    """Thinking capability and supported type configurations."""
