# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import TypedDict

__all__ = ["FineTuneListVoicesParams"]


class FineTuneListVoicesParams(TypedDict, total=False):
    ending_before: Optional[str]
    """A cursor to use in pagination.

    `ending_before` is a voice ID that defines your place in the list. For example,
    if you make a fine-tune voices request and receive 20 objects, starting with
    `voice_abc123`, your subsequent call can include `ending_before=voice_abc123` to
    fetch the previous page of the list.
    """

    limit: Optional[int]
    """The number of voices to return per page, ranging between 1 and 100."""

    starting_after: Optional[str]
    """A cursor to use in pagination.

    `starting_after` is a voice ID that defines your place in the list. For example,
    if you make a fine-tune voices request and receive 20 objects, ending with
    `voice_abc123`, your subsequent call can include `starting_after=voice_abc123`
    to fetch the next page of the list.
    """
