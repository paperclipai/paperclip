# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel

__all__ = ["CacheCreation"]


class CacheCreation(BaseModel):
    ephemeral_1h_input_tokens: int
    """The number of input tokens used to create the 1 hour cache entry."""

    ephemeral_5m_input_tokens: int
    """The number of input tokens used to create the 5 minute cache entry."""
