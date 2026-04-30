# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from datetime import datetime

from .._models import BaseModel
from .supported_language import SupportedLanguage

__all__ = ["VoiceMetadata"]


class VoiceMetadata(BaseModel):
    id: str
    """The ID of the voice."""

    created_at: datetime
    """The date and time the voice was created."""

    description: str
    """The description of the voice."""

    is_public: bool
    """Whether the voice is publicly accessible."""

    language: SupportedLanguage
    """The language that the given voice should speak the transcript in.

    For valid options, see [Models](/build-with-cartesia/tts-models).
    """

    name: str
    """The name of the voice."""

    user_id: str
    """The ID of the user who owns the voice."""
