# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Optional
from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsAgentToolUseEvent"]


class BetaManagedAgentsAgentToolUseEvent(BaseModel):
    """Event emitted when the agent invokes a built-in agent tool."""

    id: str
    """Unique identifier for this event."""

    input: Dict[str, object]
    """Input parameters for the tool call."""

    name: str
    """Name of the agent tool being used."""

    processed_at: datetime
    """A timestamp in RFC 3339 format"""

    type: Literal["agent.tool_use"]

    evaluated_permission: Optional[Literal["allow", "ask", "deny"]] = None
    """AgentEvaluatedPermission enum"""
