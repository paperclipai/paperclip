# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from datetime import datetime
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_session_end_turn import BetaManagedAgentsSessionEndTurn
from .beta_managed_agents_session_requires_action import BetaManagedAgentsSessionRequiresAction
from .beta_managed_agents_session_retries_exhausted import BetaManagedAgentsSessionRetriesExhausted

__all__ = ["BetaManagedAgentsSessionStatusIdleEvent", "StopReason"]

StopReason: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsSessionEndTurn,
        BetaManagedAgentsSessionRequiresAction,
        BetaManagedAgentsSessionRetriesExhausted,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsSessionStatusIdleEvent(BaseModel):
    """Indicates the agent has paused and is awaiting user input."""

    id: str
    """Unique identifier for this event."""

    processed_at: datetime
    """A timestamp in RFC 3339 format"""

    stop_reason: StopReason
    """The agent completed its turn naturally and is ready for the next user message."""

    type: Literal["session.status_idle"]
