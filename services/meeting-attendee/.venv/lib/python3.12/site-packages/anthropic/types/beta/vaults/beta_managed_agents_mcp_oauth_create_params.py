# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from datetime import datetime
from typing_extensions import Literal, Required, Annotated, TypedDict

from ...._utils import PropertyInfo
from .beta_managed_agents_mcp_oauth_refresh_params import BetaManagedAgentsMCPOAuthRefreshParams

__all__ = ["BetaManagedAgentsMCPOAuthCreateParams"]


class BetaManagedAgentsMCPOAuthCreateParams(TypedDict, total=False):
    """Parameters for creating an MCP OAuth credential."""

    access_token: Required[str]
    """OAuth access token."""

    mcp_server_url: Required[str]
    """URL of the MCP server this credential authenticates against."""

    type: Required[Literal["mcp_oauth"]]

    expires_at: Annotated[Union[str, datetime, None], PropertyInfo(format="iso8601")]
    """A timestamp in RFC 3339 format"""

    refresh: Optional[BetaManagedAgentsMCPOAuthRefreshParams]
    """OAuth refresh token parameters for creating a credential with refresh support."""
