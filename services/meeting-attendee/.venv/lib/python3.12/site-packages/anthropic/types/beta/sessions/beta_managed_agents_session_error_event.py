# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from datetime import datetime
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_billing_error import BetaManagedAgentsBillingError
from .beta_managed_agents_unknown_error import BetaManagedAgentsUnknownError
from .beta_managed_agents_model_overloaded_error import BetaManagedAgentsModelOverloadedError
from .beta_managed_agents_model_rate_limited_error import BetaManagedAgentsModelRateLimitedError
from .beta_managed_agents_model_request_failed_error import BetaManagedAgentsModelRequestFailedError
from .beta_managed_agents_mcp_connection_failed_error import BetaManagedAgentsMCPConnectionFailedError
from .beta_managed_agents_mcp_authentication_failed_error import BetaManagedAgentsMCPAuthenticationFailedError

__all__ = ["BetaManagedAgentsSessionErrorEvent", "Error"]

Error: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsUnknownError,
        BetaManagedAgentsModelOverloadedError,
        BetaManagedAgentsModelRateLimitedError,
        BetaManagedAgentsModelRequestFailedError,
        BetaManagedAgentsMCPConnectionFailedError,
        BetaManagedAgentsMCPAuthenticationFailedError,
        BetaManagedAgentsBillingError,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsSessionErrorEvent(BaseModel):
    """An error event indicating a problem occurred during session execution."""

    id: str
    """Unique identifier for this event."""

    error: Error
    """An unknown or unexpected error occurred during session execution.

    A fallback variant; clients that don't recognize a new error code can match on
    `retry_status` and `message` alone.
    """

    processed_at: datetime
    """A timestamp in RFC 3339 format"""

    type: Literal["session.error"]
