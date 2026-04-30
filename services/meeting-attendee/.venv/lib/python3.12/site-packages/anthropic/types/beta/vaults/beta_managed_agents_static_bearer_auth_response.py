# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsStaticBearerAuthResponse"]


class BetaManagedAgentsStaticBearerAuthResponse(BaseModel):
    """Static bearer token credential details for an MCP server."""

    mcp_server_url: str
    """URL of the MCP server this credential authenticates against."""

    type: Literal["static_bearer"]
