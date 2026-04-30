# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from datetime import datetime
from typing_extensions import Literal, Required, Annotated, TypedDict

from ...._utils import PropertyInfo
from .beta_managed_agents_mcp_oauth_refresh_update_params import BetaManagedAgentsMCPOAuthRefreshUpdateParams

__all__ = ["BetaManagedAgentsMCPOAuthUpdateParams"]


class BetaManagedAgentsMCPOAuthUpdateParams(TypedDict, total=False):
    """Parameters for updating an MCP OAuth credential.

    The `mcp_server_url` is immutable.
    """

    type: Required[Literal["mcp_oauth"]]

    access_token: Optional[str]
    """Updated OAuth access token."""

    expires_at: Annotated[Union[str, datetime, None], PropertyInfo(format="iso8601")]
    """A timestamp in RFC 3339 format"""

    refresh: Optional[BetaManagedAgentsMCPOAuthRefreshUpdateParams]
    """Parameters for updating OAuth refresh token configuration."""
