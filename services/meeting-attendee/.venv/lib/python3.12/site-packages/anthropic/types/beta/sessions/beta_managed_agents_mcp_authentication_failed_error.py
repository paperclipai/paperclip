# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_retry_status_retrying import BetaManagedAgentsRetryStatusRetrying
from .beta_managed_agents_retry_status_terminal import BetaManagedAgentsRetryStatusTerminal
from .beta_managed_agents_retry_status_exhausted import BetaManagedAgentsRetryStatusExhausted

__all__ = ["BetaManagedAgentsMCPAuthenticationFailedError", "RetryStatus"]

RetryStatus: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsRetryStatusRetrying,
        BetaManagedAgentsRetryStatusExhausted,
        BetaManagedAgentsRetryStatusTerminal,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsMCPAuthenticationFailedError(BaseModel):
    """Authentication to an MCP server failed."""

    mcp_server_name: str
    """Name of the MCP server that failed authentication."""

    message: str
    """Human-readable error description."""

    retry_status: RetryStatus
    """What the client should do next in response to this error."""

    type: Literal["mcp_authentication_failed_error"]
