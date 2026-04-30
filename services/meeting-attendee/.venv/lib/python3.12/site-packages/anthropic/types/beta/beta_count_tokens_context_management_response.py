# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ..._models import BaseModel

__all__ = ["BetaCountTokensContextManagementResponse"]


class BetaCountTokensContextManagementResponse(BaseModel):
    original_input_tokens: int
    """The original token count before context management was applied"""
