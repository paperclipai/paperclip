# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["VoiceSpecifier"]


class VoiceSpecifier(BaseModel):
    id: str
    """The ID of the voice."""

    mode: Literal["id"]
