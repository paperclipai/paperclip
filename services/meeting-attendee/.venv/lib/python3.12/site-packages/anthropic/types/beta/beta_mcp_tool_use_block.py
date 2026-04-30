# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaMCPToolUseBlock"]


class BetaMCPToolUseBlock(BaseModel):
    id: str

    input: Dict[str, object]

    name: str
    """The name of the MCP tool"""

    server_name: str
    """The name of the MCP server"""

    type: Literal["mcp_tool_use"]
