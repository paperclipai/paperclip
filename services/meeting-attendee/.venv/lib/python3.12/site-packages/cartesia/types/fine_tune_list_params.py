# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import TypedDict

__all__ = ["FineTuneListParams"]


class FineTuneListParams(TypedDict, total=False):
    ending_before: Optional[str]
    """A cursor to use in pagination.

    `ending_before` is a fine-tune ID that defines your place in the list. For
    example, if you make a /fine-tunes request and receive 20 objects, starting with
    `fine_tune_abc123`, your subsequent call can include
    `ending_before=fine_tune_abc123` to fetch the previous page of the list.
    """

    limit: Optional[int]
    """The number of fine-tunes to return per page, ranging between 1 and 100."""

    starting_after: Optional[str]
    """A cursor to use in pagination.

    `starting_after` is a fine-tune ID that defines your place in the list. For
    example, if you make a /fine-tunes request and receive 20 objects, ending with
    `fine_tune_abc123`, your subsequent call can include
    `starting_after=fine_tune_abc123` to fetch the next page of the list.
    """
