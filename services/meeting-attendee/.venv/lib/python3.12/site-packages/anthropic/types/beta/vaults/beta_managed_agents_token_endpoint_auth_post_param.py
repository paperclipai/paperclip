# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsTokenEndpointAuthPostParam"]


class BetaManagedAgentsTokenEndpointAuthPostParam(TypedDict, total=False):
    """Token endpoint uses POST body authentication with client credentials."""

    client_secret: Required[str]
    """OAuth client secret."""

    type: Required[Literal["client_secret_post"]]
