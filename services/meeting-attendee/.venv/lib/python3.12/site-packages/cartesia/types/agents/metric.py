# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime

from ..._models import BaseModel

__all__ = ["Metric"]


class Metric(BaseModel):
    id: str
    """The unique identifier for the metric."""

    created_at: datetime
    """The timestamp when the metric was created."""

    name: str
    """The name of the metric.

    This is a unique name that you can use to identify the metric in the CLI.
    """

    prompt: str
    """
    The prompt associated with the metric, detailing the task and evaluation
    criteria.
    """

    display_name: Optional[str] = None
    """The display name of the metric, if available.

    This is the name that is displayed in the Playground.
    """
