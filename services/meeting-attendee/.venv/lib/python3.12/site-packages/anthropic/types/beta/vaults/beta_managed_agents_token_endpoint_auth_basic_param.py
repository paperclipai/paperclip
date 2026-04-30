# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsTokenEndpointAuthBasicParam"]


class BetaManagedAgentsTokenEndpointAuthBasicParam(TypedDict, total=False):
    """Token endpoint uses HTTP Basic authentication with client credentials."""

    client_secret: Required[str]
    """OAuth client secret."""

    type: Required[Literal["client_secret_basic"]]
