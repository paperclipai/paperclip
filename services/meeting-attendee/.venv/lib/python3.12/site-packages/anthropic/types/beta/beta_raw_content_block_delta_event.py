# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel
from .beta_raw_content_block_delta import BetaRawContentBlockDelta

__all__ = ["BetaRawContentBlockDeltaEvent"]


class BetaRawContentBlockDeltaEvent(BaseModel):
    delta: BetaRawContentBlockDelta

    index: int

    type: Literal["content_block_delta"]
