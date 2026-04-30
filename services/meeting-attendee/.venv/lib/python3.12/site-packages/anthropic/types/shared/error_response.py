# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel
from .error_object import ErrorObject

__all__ = ["ErrorResponse"]


class ErrorResponse(BaseModel):
    error: ErrorObject

    request_id: Optional[str] = None

    type: Literal["error"]
