# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Required, TypedDict

from .gender_presentation import GenderPresentation

__all__ = ["VoiceUpdateParams"]


class VoiceUpdateParams(TypedDict, total=False):
    description: Required[str]
    """The description of the voice."""

    name: Required[str]
    """The name of the voice."""

    gender: Optional[GenderPresentation]
