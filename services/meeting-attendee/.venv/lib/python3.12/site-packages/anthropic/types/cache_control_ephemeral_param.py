# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["CacheControlEphemeralParam"]


class CacheControlEphemeralParam(TypedDict, total=False):
    type: Required[Literal["ephemeral"]]

    ttl: Literal["5m", "1h"]
    """The time-to-live for the cache control breakpoint.

    This may be one the following values:

    - `5m`: 5 minutes
    - `1h`: 1 hour

    Defaults to `5m`.
    """
