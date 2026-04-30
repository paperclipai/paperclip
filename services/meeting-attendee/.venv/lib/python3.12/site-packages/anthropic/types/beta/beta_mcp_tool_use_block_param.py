# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaMCPToolUseBlockParam"]


class BetaMCPToolUseBlockParam(TypedDict, total=False):
    id: Required[str]

    input: Required[Dict[str, object]]

    name: Required[str]

    server_name: Required[str]
    """The name of the MCP server"""

    type: Required[Literal["mcp_tool_use"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
