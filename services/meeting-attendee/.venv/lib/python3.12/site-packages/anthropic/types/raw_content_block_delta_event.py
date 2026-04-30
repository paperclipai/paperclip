# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel
from .raw_content_block_delta import RawContentBlockDelta

__all__ = ["RawContentBlockDeltaEvent"]


class RawContentBlockDeltaEvent(BaseModel):
    delta: RawContentBlockDelta

    index: int

    type: Literal["content_block_delta"]
