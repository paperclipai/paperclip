# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsMCPServerURLDefinition"]


class BetaManagedAgentsMCPServerURLDefinition(BaseModel):
    """URL-based MCP server connection as returned in API responses."""

    name: str

    type: Literal["url"]

    url: str
