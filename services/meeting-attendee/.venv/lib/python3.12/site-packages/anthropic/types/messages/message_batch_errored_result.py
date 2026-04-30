# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel
from ..shared.error_response import ErrorResponse

__all__ = ["MessageBatchErroredResult"]


class MessageBatchErroredResult(BaseModel):
    error: ErrorResponse

    type: Literal["errored"]
