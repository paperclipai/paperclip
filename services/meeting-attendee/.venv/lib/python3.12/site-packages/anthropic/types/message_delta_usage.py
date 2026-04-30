# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from .._models import BaseModel
from .server_tool_usage import ServerToolUsage

__all__ = ["MessageDeltaUsage"]


class MessageDeltaUsage(BaseModel):
    cache_creation_input_tokens: Optional[int] = None
    """The cumulative number of input tokens used to create the cache entry."""

    cache_read_input_tokens: Optional[int] = None
    """The cumulative number of input tokens read from the cache."""

    input_tokens: Optional[int] = None
    """The cumulative number of input tokens which were used."""

    output_tokens: int
    """The cumulative number of output tokens which were used."""

    server_tool_use: Optional[ServerToolUsage] = None
    """The number of server tool requests."""
