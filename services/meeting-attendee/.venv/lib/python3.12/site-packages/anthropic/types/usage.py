# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel
from .cache_creation import CacheCreation
from .server_tool_usage import ServerToolUsage

__all__ = ["Usage"]


class Usage(BaseModel):
    cache_creation: Optional[CacheCreation] = None
    """Breakdown of cached tokens by TTL"""

    cache_creation_input_tokens: Optional[int] = None
    """The number of input tokens used to create the cache entry."""

    cache_read_input_tokens: Optional[int] = None
    """The number of input tokens read from the cache."""

    inference_geo: Optional[str] = None
    """The geographic region where inference was performed for this request."""

    input_tokens: int
    """The number of input tokens which were used."""

    output_tokens: int
    """The number of output tokens which were used."""

    server_tool_use: Optional[ServerToolUsage] = None
    """The number of server tool requests."""

    service_tier: Optional[Literal["standard", "priority", "batch"]] = None
    """If the request used the priority, standard, or batch tier."""
