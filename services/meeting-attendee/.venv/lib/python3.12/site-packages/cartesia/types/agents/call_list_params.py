# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Required, TypedDict

__all__ = ["CallListParams"]


class CallListParams(TypedDict, total=False):
    agent_id: Required[str]
    """The ID of the agent."""

    ending_before: Optional[str]
    """(Pagination option) The ID of the call to end before."""

    expand: Optional[str]
    """The fields to expand in the response.

    Currently, the only supported value is `transcript`.
    """

    limit: Optional[int]
    """
    (Pagination option) The number of calls to return per page, ranging between 1
    and 100.
    """

    starting_after: Optional[str]
    """(Pagination option)The ID of the call to start after."""
