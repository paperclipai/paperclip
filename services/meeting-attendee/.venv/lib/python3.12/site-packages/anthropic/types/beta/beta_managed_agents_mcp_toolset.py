# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_managed_agents_mcp_tool_config import BetaManagedAgentsMCPToolConfig
from .beta_managed_agents_mcp_toolset_default_config import BetaManagedAgentsMCPToolsetDefaultConfig

__all__ = ["BetaManagedAgentsMCPToolset"]


class BetaManagedAgentsMCPToolset(BaseModel):
    configs: List[BetaManagedAgentsMCPToolConfig]

    default_config: BetaManagedAgentsMCPToolsetDefaultConfig
    """Resolved default configuration for all tools from an MCP server."""

    mcp_server_name: str

    type: Literal["mcp_toolset"]
