# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaLimitedNetwork"]


class BetaLimitedNetwork(BaseModel):
    """Limited network access."""

    allow_mcp_servers: bool
    """
    Permits outbound access to MCP server endpoints configured on the agent, beyond
    those listed in the `allowed_hosts` array.
    """

    allow_package_managers: bool
    """
    Permits outbound access to public package registries (PyPI, npm, etc.) beyond
    those listed in the `allowed_hosts` array.
    """

    allowed_hosts: List[str]
    """Specifies domains the container can reach."""

    type: Literal["limited"]
    """Network policy type"""
