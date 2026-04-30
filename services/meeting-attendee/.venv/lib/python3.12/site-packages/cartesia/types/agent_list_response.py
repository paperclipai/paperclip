# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List

from .._models import BaseModel
from .agent_summary import AgentSummary

__all__ = ["AgentListResponse"]


class AgentListResponse(BaseModel):
    summaries: List[AgentSummary]
    """The summaries of the agents."""
