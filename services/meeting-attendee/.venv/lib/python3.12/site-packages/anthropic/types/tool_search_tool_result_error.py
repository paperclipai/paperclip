# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel
from .tool_search_tool_result_error_code import ToolSearchToolResultErrorCode

__all__ = ["ToolSearchToolResultError"]


class ToolSearchToolResultError(BaseModel):
    error_code: ToolSearchToolResultErrorCode

    error_message: Optional[str] = None

    type: Literal["tool_search_tool_result_error"]
