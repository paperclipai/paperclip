# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_container import BetaContainer
from .beta_stop_reason import BetaStopReason
from .beta_message_delta_usage import BetaMessageDeltaUsage
from .beta_refusal_stop_details import BetaRefusalStopDetails
from .beta_context_management_response import BetaContextManagementResponse

__all__ = ["BetaRawMessageDeltaEvent", "Delta"]


class Delta(BaseModel):
    container: Optional[BetaContainer] = None
    """
    Information about the container used in the request (for the code execution
    tool)
    """

    stop_details: Optional[BetaRefusalStopDetails] = None
    """Structured information about a refusal."""

    stop_reason: Optional[BetaStopReason] = None

    stop_sequence: Optional[str] = None


class BetaRawMessageDeltaEvent(BaseModel):
    context_management: Optional[BetaContextManagementResponse] = None
    """Information about context management strategies applied during the request"""

    delta: Delta

    type: Literal["message_delta"]

    usage: BetaMessageDeltaUsage
    """Billing and rate-limit usage.

    Anthropic's API bills and rate-limits by token counts, as tokens represent the
    underlying cost to our systems.

    Under the hood, the API transforms requests into a format suitable for the
    model. The model's output then goes through a parsing stage before becoming an
    API response. As a result, the token counts in `usage` will not match one-to-one
    with the exact visible content of an API request or response.

    For example, `output_tokens` will be non-zero, even for an empty string response
    from Claude.

    Total input tokens in a request is the summation of `input_tokens`,
    `cache_creation_input_tokens`, and `cache_read_input_tokens`.
    """
