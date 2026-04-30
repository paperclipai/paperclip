# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from ..._models import BaseModel
from .beta_iterations_usage import BetaIterationsUsage
from .beta_server_tool_usage import BetaServerToolUsage

__all__ = ["BetaMessageDeltaUsage"]


class BetaMessageDeltaUsage(BaseModel):
    cache_creation_input_tokens: Optional[int] = None
    """The cumulative number of input tokens used to create the cache entry."""

    cache_read_input_tokens: Optional[int] = None
    """The cumulative number of input tokens read from the cache."""

    input_tokens: Optional[int] = None
    """The cumulative number of input tokens which were used."""

    iterations: Optional[BetaIterationsUsage] = None
    """Per-iteration token usage breakdown.

    Each entry represents one sampling iteration, with its own input/output token
    counts and cache statistics. This allows you to:

    - Determine which iterations exceeded long context thresholds (>=200k tokens)
    - Calculate the true context window size from the last iteration
    - Understand token accumulation across server-side tool use loops
    """

    output_tokens: int
    """The cumulative number of output tokens which were used."""

    server_tool_use: Optional[BetaServerToolUsage] = None
    """The number of server tool requests."""
