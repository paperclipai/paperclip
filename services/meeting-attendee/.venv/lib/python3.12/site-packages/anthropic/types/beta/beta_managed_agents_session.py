# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, List, Optional
from datetime import datetime
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_managed_agents_session_agent import BetaManagedAgentsSessionAgent
from .beta_managed_agents_session_stats import BetaManagedAgentsSessionStats
from .beta_managed_agents_session_usage import BetaManagedAgentsSessionUsage
from .sessions.beta_managed_agents_session_resource import BetaManagedAgentsSessionResource

__all__ = ["BetaManagedAgentsSession"]


class BetaManagedAgentsSession(BaseModel):
    """A Managed Agents `session`."""

    id: str

    agent: BetaManagedAgentsSessionAgent
    """Resolved `agent` definition for a `session`.

    Snapshot of the `agent` at `session` creation time.
    """

    archived_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    environment_id: str

    metadata: Dict[str, str]

    resources: List[BetaManagedAgentsSessionResource]

    stats: BetaManagedAgentsSessionStats
    """Timing statistics for a session."""

    status: Literal["rescheduling", "running", "idle", "terminated"]
    """SessionStatus enum"""

    title: Optional[str] = None

    type: Literal["session"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""

    usage: BetaManagedAgentsSessionUsage
    """Cumulative token usage for a session across all turns."""

    vault_ids: List[str]
    """Vault IDs attached to the session at creation.

    Empty when no vaults were supplied.
    """
