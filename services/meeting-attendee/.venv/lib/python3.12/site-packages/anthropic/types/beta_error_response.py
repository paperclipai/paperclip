# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel
from .beta_error import BetaError

__all__ = ["BetaErrorResponse"]


class BetaErrorResponse(BaseModel):
    error: BetaError

    request_id: Optional[str] = None

    type: Literal["error"]
