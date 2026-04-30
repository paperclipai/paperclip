# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsUserToolConfirmationEventParams"]


class BetaManagedAgentsUserToolConfirmationEventParams(TypedDict, total=False):
    """Parameters for confirming or denying a tool execution request."""

    result: Required[Literal["allow", "deny"]]
    """UserToolConfirmationResult enum"""

    tool_use_id: Required[str]
    """
    The id of the `agent.tool_use` or `agent.mcp_tool_use` event this result
    corresponds to, which can be found in the last `session.status_idle`
    [event's](https://platform.claude.com/docs/en/api/beta/sessions/events/list#beta_managed_agents_session_requires_action.event_ids)
    `stop_reason.event_ids` field.
    """

    type: Required[Literal["user.tool_confirmation"]]

    deny_message: Optional[str]
    """Optional message providing context for a 'deny' decision.

    Only allowed when result is 'deny'.
    """
