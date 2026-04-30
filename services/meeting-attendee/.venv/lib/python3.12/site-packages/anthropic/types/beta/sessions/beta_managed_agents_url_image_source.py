# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsURLImageSource"]


class BetaManagedAgentsURLImageSource(BaseModel):
    """Image referenced by URL."""

    type: Literal["url"]

    url: str
    """URL of the image to fetch."""
