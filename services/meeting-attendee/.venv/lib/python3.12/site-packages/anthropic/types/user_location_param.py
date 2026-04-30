# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["UserLocationParam"]


class UserLocationParam(TypedDict, total=False):
    type: Required[Literal["approximate"]]

    city: Optional[str]
    """The city of the user."""

    country: Optional[str]
    """
    The two letter
    [ISO country code](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) of the
    user.
    """

    region: Optional[str]
    """The region of the user."""

    timezone: Optional[str]
    """The [IANA timezone](https://nodatime.org/TimeZones) of the user."""
