# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsStaticBearerUpdateParams"]


class BetaManagedAgentsStaticBearerUpdateParams(TypedDict, total=False):
    """Parameters for updating a static bearer token credential.

    The `mcp_server_url` is immutable.
    """

    type: Required[Literal["static_bearer"]]

    token: Optional[str]
    """Updated static bearer token value."""
