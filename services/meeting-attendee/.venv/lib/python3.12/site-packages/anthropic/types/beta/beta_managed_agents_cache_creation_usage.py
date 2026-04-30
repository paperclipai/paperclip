# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsCacheCreationUsage"]


class BetaManagedAgentsCacheCreationUsage(BaseModel):
    """Prompt-cache creation token usage broken down by cache lifetime."""

    ephemeral_1h_input_tokens: Optional[int] = None
    """Tokens used to create 1-hour ephemeral cache entries."""

    ephemeral_5m_input_tokens: Optional[int] = None
    """Tokens used to create 5-minute ephemeral cache entries."""
