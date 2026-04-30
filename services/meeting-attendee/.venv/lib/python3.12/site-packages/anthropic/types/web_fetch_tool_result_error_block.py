# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel
from .web_fetch_tool_result_error_code import WebFetchToolResultErrorCode

__all__ = ["WebFetchToolResultErrorBlock"]


class WebFetchToolResultErrorBlock(BaseModel):
    error_code: WebFetchToolResultErrorCode

    type: Literal["web_fetch_tool_result_error"]
