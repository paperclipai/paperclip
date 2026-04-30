# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel
from .container import Container
from .stop_reason import StopReason
from .message_delta_usage import MessageDeltaUsage
from .refusal_stop_details import RefusalStopDetails

__all__ = ["RawMessageDeltaEvent", "Delta"]


class Delta(BaseModel):
    container: Optional[Container] = None
    """
    Information about the container used in the request (for the code execution
    tool)
    """

    stop_details: Optional[RefusalStopDetails] = None
    """Structured information about a refusal."""

    stop_reason: Optional[StopReason] = None

    stop_sequence: Optional[str] = None


class RawMessageDeltaEvent(BaseModel):
    delta: Delta

    type: Literal["message_delta"]

    usage: MessageDeltaUsage
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
