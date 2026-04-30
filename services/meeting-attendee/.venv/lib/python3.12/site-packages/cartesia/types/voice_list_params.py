# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, TypedDict

from .gender_presentation import GenderPresentation

__all__ = ["VoiceListParams"]


class VoiceListParams(TypedDict, total=False):
    ending_before: Optional[str]
    """A cursor to use in pagination.

    `ending_before` is a Voice ID that defines your place in the list. For example,
    if you make a /voices request and receive 100 objects, starting with
    `voice_abc123`, your subsequent call can include `ending_before=voice_abc123` to
    fetch the previous page of the list.
    """

    expand: Optional[List[Literal["preview_file_url"]]]
    """Additional fields to include in the response."""

    gender: Optional[GenderPresentation]
    """The gender presentation of the voices to return."""

    is_owner: Optional[bool]
    """Whether to only return voices owned your organization."""

    limit: Optional[int]
    """The number of Voices to return per page, ranging between 1 and 100."""

    q: Optional[str]
    """Query string to search for voices by name, description, or Voice ID."""

    starting_after: Optional[str]
    """A cursor to use in pagination.

    `starting_after` is a Voice ID that defines your place in the list. For example,
    if you make a /voices request and receive 100 objects, ending with
    `voice_abc123`, your subsequent call can include `starting_after=voice_abc123`
    to fetch the next page of the list.
    """
