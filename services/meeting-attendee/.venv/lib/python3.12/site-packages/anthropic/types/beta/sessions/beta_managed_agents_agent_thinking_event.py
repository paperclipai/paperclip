# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsAgentThinkingEvent"]


class BetaManagedAgentsAgentThinkingEvent(BaseModel):
    """Indicates the agent is making forward progress via extended thinking.

    A progress signal, not a content carrier.
    """

    id: str
    """Unique identifier for this event."""

    processed_at: datetime
    """A timestamp in RFC 3339 format"""

    type: Literal["agent.thinking"]
