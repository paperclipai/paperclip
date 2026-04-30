# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsStaticBearerCreateParams"]


class BetaManagedAgentsStaticBearerCreateParams(TypedDict, total=False):
    """Parameters for creating a static bearer token credential."""

    token: Required[str]
    """Static bearer token value."""

    mcp_server_url: Required[str]
    """URL of the MCP server this credential authenticates against."""

    type: Required[Literal["static_bearer"]]
