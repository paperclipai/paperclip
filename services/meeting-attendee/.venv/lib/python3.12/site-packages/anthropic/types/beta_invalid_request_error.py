# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["BetaInvalidRequestError"]


class BetaInvalidRequestError(BaseModel):
    message: str

    type: Literal["invalid_request_error"]
