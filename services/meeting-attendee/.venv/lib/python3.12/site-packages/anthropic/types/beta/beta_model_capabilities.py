# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ..._models import BaseModel
from .beta_effort_capability import BetaEffortCapability
from .beta_capability_support import BetaCapabilitySupport
from .beta_thinking_capability import BetaThinkingCapability
from .beta_context_management_capability import BetaContextManagementCapability

__all__ = ["BetaModelCapabilities"]


class BetaModelCapabilities(BaseModel):
    """Model capability information."""

    batch: BetaCapabilitySupport
    """Whether the model supports the Batch API."""

    citations: BetaCapabilitySupport
    """Whether the model supports citation generation."""

    code_execution: BetaCapabilitySupport
    """Whether the model supports code execution tools."""

    context_management: BetaContextManagementCapability
    """Context management support and available strategies."""

    effort: BetaEffortCapability
    """Effort (reasoning_effort) support and available levels."""

    image_input: BetaCapabilitySupport
    """Whether the model accepts image content blocks."""

    pdf_input: BetaCapabilitySupport
    """Whether the model accepts PDF content blocks."""

    structured_outputs: BetaCapabilitySupport
    """Whether the model supports structured output / JSON mode / strict tool schemas."""

    thinking: BetaThinkingCapability
    """Thinking capability and supported type configurations."""
