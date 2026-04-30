# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime

from .._models import BaseModel
from .supported_language import SupportedLanguage
from .gender_presentation import GenderPresentation

__all__ = ["Voice"]


class Voice(BaseModel):
    id: str
    """The ID of the voice."""

    created_at: datetime
    """The date and time the voice was created."""

    description: str
    """The description of the voice."""

    is_owner: bool
    """Whether your organization owns the voice."""

    is_public: bool
    """Whether the voice is publicly accessible."""

    language: SupportedLanguage
    """The language that the given voice should speak the transcript in.

    For valid options, see [Models](/build-with-cartesia/tts-models).
    """

    name: str
    """The name of the voice."""

    gender: Optional[GenderPresentation] = None
    """The gender of the voice, if specified."""

    preview_file_url: Optional[str] = None
    """A URL to download a preview audio file for this voice.

    Useful to avoid consuming credits when looking for the right voice. The URL
    requires the same Authorization header. Voice previews may be changed, moved, or
    deleted so you should avoid storing the URL permanently. This property will be
    null if there's no preview available. Only included when `expand[]` includes
    `preview_file_url`.
    """
