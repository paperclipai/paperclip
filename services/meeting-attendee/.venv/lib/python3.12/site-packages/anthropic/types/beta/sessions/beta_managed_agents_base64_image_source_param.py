# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsBase64ImageSourceParam"]


class BetaManagedAgentsBase64ImageSourceParam(TypedDict, total=False):
    """Base64-encoded image data."""

    data: Required[str]
    """Base64-encoded image data."""

    media_type: Required[str]
    """
    MIME type of the image (e.g., "image/png", "image/jpeg", "image/gif",
    "image/webp").
    """

    type: Required[Literal["base64"]]
