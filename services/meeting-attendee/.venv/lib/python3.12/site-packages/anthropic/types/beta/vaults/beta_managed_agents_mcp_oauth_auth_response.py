# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel
from .beta_managed_agents_mcp_oauth_refresh_response import BetaManagedAgentsMCPOAuthRefreshResponse

__all__ = ["BetaManagedAgentsMCPOAuthAuthResponse"]


class BetaManagedAgentsMCPOAuthAuthResponse(BaseModel):
    """OAuth credential details for an MCP server."""

    mcp_server_url: str
    """URL of the MCP server this credential authenticates against."""

    type: Literal["mcp_oauth"]

    expires_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""

    refresh: Optional[BetaManagedAgentsMCPOAuthRefreshResponse] = None
    """OAuth refresh token configuration returned in credential responses."""
