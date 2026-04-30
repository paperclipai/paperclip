# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import TypedDict

__all__ = ["MetricListParams"]


class MetricListParams(TypedDict, total=False):
    limit: Optional[int]
    """
    (Pagination option) The number of metrics to return per page, ranging between 1
    and 100. The default page limit is 10.
    """

    starting_after: Optional[str]
    """
    (Pagination option) The ID of the last Metric in the current response as a
    cursor for the next page of results.
    """
