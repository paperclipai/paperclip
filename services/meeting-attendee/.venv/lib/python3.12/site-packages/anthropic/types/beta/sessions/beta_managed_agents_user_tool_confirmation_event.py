# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsUserToolConfirmationEvent"]


class BetaManagedAgentsUserToolConfirmationEvent(BaseModel):
    """A tool confirmation event that approves or denies a pending tool execution."""

    id: str
    """Unique identifier for this event."""

    result: Literal["allow", "deny"]
    """UserToolConfirmationResult enum"""

    tool_use_id: str
    """
    The id of the `agent.tool_use` or `agent.mcp_tool_use` event this result
    corresponds to, which can be found in the last `session.status_idle`
    [event's](https://platform.claude.com/docs/en/api/beta/sessions/events/list#beta_managed_agents_session_requires_action.event_ids)
    `stop_reason.event_ids` field.
    """

    type: Literal["user.tool_confirmation"]

    deny_message: Optional[str] = None
    """Optional message providing context for a 'deny' decision.

    Only allowed when result is 'deny'.
    """

    processed_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""
