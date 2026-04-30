# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from ..._types import SequenceNotStr

__all__ = ["BetaLimitedNetworkParams"]


class BetaLimitedNetworkParams(TypedDict, total=False):
    """Limited network request params.

    Fields default to null; on update, omitted fields preserve the
    existing value.
    """

    type: Required[Literal["limited"]]
    """Network policy type"""

    allow_mcp_servers: Optional[bool]
    """
    Permits outbound access to MCP server endpoints configured on the agent, beyond
    those listed in the `allowed_hosts` array. Defaults to `false`.
    """

    allow_package_managers: Optional[bool]
    """
    Permits outbound access to public package registries (PyPI, npm, etc.) beyond
    those listed in the `allowed_hosts` array. Defaults to `false`.
    """

    allowed_hosts: Optional[SequenceNotStr[str]]
    """Specifies domains the container can reach."""
