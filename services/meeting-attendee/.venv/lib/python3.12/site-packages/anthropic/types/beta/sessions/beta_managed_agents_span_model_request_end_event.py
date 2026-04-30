# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime
from typing_extensions import Literal

from ...._compat import PYDANTIC_V1, ConfigDict
from ...._models import BaseModel
from .beta_managed_agents_span_model_usage import BetaManagedAgentsSpanModelUsage

__all__ = ["BetaManagedAgentsSpanModelRequestEndEvent"]


class BetaManagedAgentsSpanModelRequestEndEvent(BaseModel):
    """Emitted when a model request completes."""

    id: str
    """Unique identifier for this event."""

    is_error: Optional[bool] = None
    """Whether the model request resulted in an error."""

    model_request_start_id: str
    """The id of the corresponding `span.model_request_start` event."""

    model_usage: BetaManagedAgentsSpanModelUsage
    """Token usage for a single model request."""

    processed_at: datetime
    """A timestamp in RFC 3339 format"""

    type: Literal["span.model_request_end"]

    if not PYDANTIC_V1:
        # allow fields with a `model_` prefix
        model_config = ConfigDict(protected_namespaces=tuple())
