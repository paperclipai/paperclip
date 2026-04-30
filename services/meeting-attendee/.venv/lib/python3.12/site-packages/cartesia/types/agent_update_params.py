# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import TypedDict

__all__ = ["AgentUpdateParams"]


class AgentUpdateParams(TypedDict, total=False):
    description: Optional[str]
    """The description of the agent."""

    name: Optional[str]
    """The name of the agent."""

    tts_language: Optional[str]
    """The language to use for text-to-speech."""

    tts_voice: Optional[str]
    """The voice to use for text-to-speech."""
