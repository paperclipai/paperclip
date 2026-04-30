# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaSignatureDelta"]


class BetaSignatureDelta(BaseModel):
    signature: str

    type: Literal["signature_delta"]
