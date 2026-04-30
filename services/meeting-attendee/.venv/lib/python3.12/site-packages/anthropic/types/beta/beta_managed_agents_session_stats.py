# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsSessionStats"]


class BetaManagedAgentsSessionStats(BaseModel):
    """Timing statistics for a session."""

    active_seconds: Optional[float] = None
    """Cumulative time in seconds the session spent in running status.

    Excludes idle time.
    """

    duration_seconds: Optional[float] = None
    """Elapsed time since session creation in seconds.

    For terminated sessions, frozen at the final update.
    """
