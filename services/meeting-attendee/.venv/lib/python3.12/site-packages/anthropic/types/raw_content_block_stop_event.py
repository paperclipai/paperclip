# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["RawContentBlockStopEvent"]


class RawContentBlockStopEvent(BaseModel):
    index: int

    type: Literal["content_block_stop"]
