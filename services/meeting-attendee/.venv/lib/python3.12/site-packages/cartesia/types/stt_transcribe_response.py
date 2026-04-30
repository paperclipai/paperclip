# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional

from .._models import BaseModel

__all__ = ["SttTranscribeResponse", "Word"]


class Word(BaseModel):
    end: float
    """End time of the word in seconds."""

    start: float
    """Start time of the word in seconds."""

    word: str
    """The transcribed word."""


class SttTranscribeResponse(BaseModel):
    text: str
    """The transcribed text."""

    duration: Optional[float] = None
    """The duration of the input audio in seconds."""

    language: Optional[str] = None
    """The specified language of the input audio."""

    words: Optional[List[Word]] = None
    """Word-level timestamps showing the start and end time of each word.

    Only included when `[word]` is passed into `timestamp_granularities[]`.
    """
