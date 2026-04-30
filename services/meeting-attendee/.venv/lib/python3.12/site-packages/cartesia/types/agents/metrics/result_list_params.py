# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from datetime import datetime
from typing_extensions import Annotated, TypedDict

from ...._utils import PropertyInfo

__all__ = ["ResultListParams"]


class ResultListParams(TypedDict, total=False):
    agent_id: Optional[str]
    """The ID of the agent."""

    call_id: Optional[str]
    """The ID of the call."""

    deployment_id: Optional[str]
    """The ID of the deployment."""

    end_date: Annotated[Union[str, datetime, None], PropertyInfo(format="iso8601")]
    """Filter metric results created before or at this ISO 8601 date/time (e.g.

    2024-04-30T23:59:59Z).
    """

    ending_before: Optional[str]
    """A cursor to use in pagination.

    `ending_before` is a metric result ID that defines your place in the list. For
    example, if you make a /metrics/results request and receive 100 objects,
    starting with `metric_result_abc123`, your subsequent call can include
    `ending_before=metric_result_abc123` to fetch the previous page of the list.
    """

    limit: Optional[int]
    """The number of metric results to return per page, ranging between 1 and 100."""

    metric_id: Optional[str]
    """The ID of the metric."""

    start_date: Annotated[Union[str, datetime, None], PropertyInfo(format="iso8601")]
    """Filter metric results created at or after this ISO 8601 date/time (e.g.

    2024-04-01T00:00:00Z).
    """

    starting_after: Optional[str]
    """A cursor to use in pagination.

    `starting_after` is a metric result ID that defines your place in the list. For
    example, if you make a /metrics/results request and receive 100 objects, ending
    with `metric_result_abc123`, your subsequent call can include
    `starting_after=metric_result_abc123` to fetch the next page of the list.
    """
