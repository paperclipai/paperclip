# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from ..._models import BaseModel
from .beta_managed_agents_cache_creation_usage import BetaManagedAgentsCacheCreationUsage

__all__ = ["BetaManagedAgentsSessionUsage"]


class BetaManagedAgentsSessionUsage(BaseModel):
    """Cumulative token usage for a session across all turns."""

    cache_creation: Optional[BetaManagedAgentsCacheCreationUsage] = None
    """Prompt-cache creation token usage broken down by cache lifetime."""

    cache_read_input_tokens: Optional[int] = None
    """Total tokens read from prompt cache."""

    input_tokens: Optional[int] = None
    """Total input tokens consumed across all turns."""

    output_tokens: Optional[int] = None
    """Total output tokens generated across all turns."""
