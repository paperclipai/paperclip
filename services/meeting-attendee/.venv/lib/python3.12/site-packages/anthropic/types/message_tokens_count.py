# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel

__all__ = ["MessageTokensCount"]


class MessageTokensCount(BaseModel):
    input_tokens: int
    """
    The total number of tokens across the provided list of messages, system prompt,
    and tools.
    """
