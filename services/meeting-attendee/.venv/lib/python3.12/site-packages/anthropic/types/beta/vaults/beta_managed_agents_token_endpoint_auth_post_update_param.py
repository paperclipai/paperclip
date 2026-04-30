# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsTokenEndpointAuthPostUpdateParam"]


class BetaManagedAgentsTokenEndpointAuthPostUpdateParam(TypedDict, total=False):
    """Updated POST body authentication parameters for the token endpoint."""

    type: Required[Literal["client_secret_post"]]

    client_secret: Optional[str]
    """Updated OAuth client secret."""
