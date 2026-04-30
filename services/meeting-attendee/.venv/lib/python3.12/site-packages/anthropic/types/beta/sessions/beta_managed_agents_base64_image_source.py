# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsBase64ImageSource"]


class BetaManagedAgentsBase64ImageSource(BaseModel):
    """Base64-encoded image data."""

    data: str
    """Base64-encoded image data."""

    media_type: str
    """
    MIME type of the image (e.g., "image/png", "image/jpeg", "image/gif",
    "image/webp").
    """

    type: Literal["base64"]
