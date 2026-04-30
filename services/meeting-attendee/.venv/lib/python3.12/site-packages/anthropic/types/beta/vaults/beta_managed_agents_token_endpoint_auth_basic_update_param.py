# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsTokenEndpointAuthBasicUpdateParam"]


class BetaManagedAgentsTokenEndpointAuthBasicUpdateParam(TypedDict, total=False):
    """Updated HTTP Basic authentication parameters for the token endpoint."""

    type: Required[Literal["client_secret_basic"]]

    client_secret: Optional[str]
    """Updated OAuth client secret."""
