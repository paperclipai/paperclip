# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel
from .beta_managed_agents_text_block import BetaManagedAgentsTextBlock

__all__ = ["BetaManagedAgentsAgentMessageEvent"]


class BetaManagedAgentsAgentMessageEvent(BaseModel):
    """An agent response event in the session conversation."""

    id: str
    """Unique identifier for this event."""

    content: List[BetaManagedAgentsTextBlock]
    """Array of text blocks comprising the agent response."""

    processed_at: datetime
    """A timestamp in RFC 3339 format"""

    type: Literal["agent.message"]
