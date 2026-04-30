# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel
from .web_search_tool_result_error_code import WebSearchToolResultErrorCode

__all__ = ["WebSearchToolResultError"]


class WebSearchToolResultError(BaseModel):
    error_code: WebSearchToolResultErrorCode

    type: Literal["web_search_tool_result_error"]
