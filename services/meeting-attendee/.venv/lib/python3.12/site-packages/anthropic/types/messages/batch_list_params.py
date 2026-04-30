# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import TypedDict

__all__ = ["BatchListParams"]


class BatchListParams(TypedDict, total=False):
    after_id: str
    """ID of the object to use as a cursor for pagination.

    When provided, returns the page of results immediately after this object.
    """

    before_id: str
    """ID of the object to use as a cursor for pagination.

    When provided, returns the page of results immediately before this object.
    """

    limit: int
    """Number of items to return per page.

    Defaults to `20`. Ranges from `1` to `1000`.
    """
