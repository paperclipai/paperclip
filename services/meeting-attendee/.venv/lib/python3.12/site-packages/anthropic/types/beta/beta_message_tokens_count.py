# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional

from ..._models import BaseModel
from .beta_count_tokens_context_management_response import BetaCountTokensContextManagementResponse

__all__ = ["BetaMessageTokensCount"]


class BetaMessageTokensCount(BaseModel):
    context_management: Optional[BetaCountTokensContextManagementResponse] = None
    """Information about context management applied to the message."""

    input_tokens: int
    """
    The total number of tokens across the provided list of messages, system prompt,
    and tools.
    """
