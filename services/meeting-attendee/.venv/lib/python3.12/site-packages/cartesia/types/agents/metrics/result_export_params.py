# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from datetime import datetime
from typing_extensions import Annotated, TypedDict

from ...._utils import PropertyInfo

__all__ = ["ResultExportParams"]


class ResultExportParams(TypedDict, total=False):
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

    metric_id: Optional[str]
    """The ID of the metric."""

    start_date: Annotated[Union[str, datetime, None], PropertyInfo(format="iso8601")]
    """Filter metric results created at or after this ISO 8601 date/time (e.g.

    2024-04-01T00:00:00Z).
    """
