# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsSessionRequiresAction"]


class BetaManagedAgentsSessionRequiresAction(BaseModel):
    """
    The agent is idle waiting on one or more blocking user-input events (tool confirmation, custom tool result, etc.). Resolving all of them transitions the session back to running.
    """

    event_ids: List[str]
    """The ids of events the agent is blocked on.

    Resolving fewer than all re-emits `session.status_idle` with the remainder.
    """

    type: Literal["requires_action"]
