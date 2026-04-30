# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsSessionStatusRescheduledEvent"]


class BetaManagedAgentsSessionStatusRescheduledEvent(BaseModel):
    """
    Indicates the session is recovering from an error state and is rescheduled for execution.
    """

    id: str
    """Unique identifier for this event."""

    processed_at: datetime
    """A timestamp in RFC 3339 format"""

    type: Literal["session.status_rescheduled"]
