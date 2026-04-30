# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_managed_agents_mcp_tool_config_params import BetaManagedAgentsMCPToolConfigParams
from .beta_managed_agents_mcp_toolset_default_config_params import BetaManagedAgentsMCPToolsetDefaultConfigParams

__all__ = ["BetaManagedAgentsMCPToolsetParams"]


class BetaManagedAgentsMCPToolsetParams(TypedDict, total=False):
    """Configuration for tools from an MCP server defined in `mcp_servers`."""

    mcp_server_name: Required[str]
    """Name of the MCP server.

    Must match a server name from the mcp_servers array. 1-255 characters.
    """

    type: Required[Literal["mcp_toolset"]]

    configs: Iterable[BetaManagedAgentsMCPToolConfigParams]
    """Per-tool configuration overrides."""

    default_config: Optional[BetaManagedAgentsMCPToolsetDefaultConfigParams]
    """Default configuration for all tools from an MCP server."""
