# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaThinkingDelta"]


class BetaThinkingDelta(BaseModel):
    thinking: str

    type: Literal["thinking_delta"]
