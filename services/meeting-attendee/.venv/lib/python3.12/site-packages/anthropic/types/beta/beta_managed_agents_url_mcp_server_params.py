# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsURLMCPServerParams"]


class BetaManagedAgentsURLMCPServerParams(TypedDict, total=False):
    """URL-based MCP server connection."""

    name: Required[str]
    """Unique name for this server, referenced by mcp_toolset configurations.

    1-255 characters.
    """

    type: Required[Literal["url"]]

    url: Required[str]
    """Endpoint URL for the MCP server."""
