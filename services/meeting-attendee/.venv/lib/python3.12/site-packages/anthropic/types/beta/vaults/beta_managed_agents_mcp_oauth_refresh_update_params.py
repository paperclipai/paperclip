# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import TypeAlias, TypedDict

from .beta_managed_agents_token_endpoint_auth_post_update_param import BetaManagedAgentsTokenEndpointAuthPostUpdateParam
from .beta_managed_agents_token_endpoint_auth_basic_update_param import (
    BetaManagedAgentsTokenEndpointAuthBasicUpdateParam,
)

__all__ = ["BetaManagedAgentsMCPOAuthRefreshUpdateParams", "TokenEndpointAuth"]

TokenEndpointAuth: TypeAlias = Union[
    BetaManagedAgentsTokenEndpointAuthBasicUpdateParam, BetaManagedAgentsTokenEndpointAuthPostUpdateParam
]


class BetaManagedAgentsMCPOAuthRefreshUpdateParams(TypedDict, total=False):
    """Parameters for updating OAuth refresh token configuration."""

    refresh_token: Optional[str]
    """Updated OAuth refresh token."""

    scope: Optional[str]
    """Updated OAuth scope for the refresh request."""

    token_endpoint_auth: TokenEndpointAuth
    """Updated HTTP Basic authentication parameters for the token endpoint."""
