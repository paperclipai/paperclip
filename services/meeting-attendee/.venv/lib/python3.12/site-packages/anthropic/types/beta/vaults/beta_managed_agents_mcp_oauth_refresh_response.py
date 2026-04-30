# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union, Optional
from typing_extensions import Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_token_endpoint_auth_none_response import BetaManagedAgentsTokenEndpointAuthNoneResponse
from .beta_managed_agents_token_endpoint_auth_post_response import BetaManagedAgentsTokenEndpointAuthPostResponse
from .beta_managed_agents_token_endpoint_auth_basic_response import BetaManagedAgentsTokenEndpointAuthBasicResponse

__all__ = ["BetaManagedAgentsMCPOAuthRefreshResponse", "TokenEndpointAuth"]

TokenEndpointAuth: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsTokenEndpointAuthNoneResponse,
        BetaManagedAgentsTokenEndpointAuthBasicResponse,
        BetaManagedAgentsTokenEndpointAuthPostResponse,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsMCPOAuthRefreshResponse(BaseModel):
    """OAuth refresh token configuration returned in credential responses."""

    client_id: str
    """OAuth client ID."""

    token_endpoint: str
    """Token endpoint URL used to refresh the access token."""

    token_endpoint_auth: TokenEndpointAuth
    """Token endpoint requires no client authentication."""

    resource: Optional[str] = None
    """OAuth resource indicator."""

    scope: Optional[str] = None
    """OAuth scope for the refresh request."""
