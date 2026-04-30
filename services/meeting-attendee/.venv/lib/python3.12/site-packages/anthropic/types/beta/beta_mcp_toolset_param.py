# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_mcp_tool_config_param import BetaMCPToolConfigParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_mcp_tool_default_config_param import BetaMCPToolDefaultConfigParam

__all__ = ["BetaMCPToolsetParam"]


class BetaMCPToolsetParam(TypedDict, total=False):
    """Configuration for a group of tools from an MCP server.

    Allows configuring enabled status and defer_loading for all tools
    from an MCP server, with optional per-tool overrides.
    """

    mcp_server_name: Required[str]
    """Name of the MCP server to configure tools for"""

    type: Required[Literal["mcp_toolset"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    configs: Optional[Dict[str, BetaMCPToolConfigParam]]
    """Configuration overrides for specific tools, keyed by tool name"""

    default_config: BetaMCPToolDefaultConfigParam
    """Default configuration applied to all tools from this server"""
