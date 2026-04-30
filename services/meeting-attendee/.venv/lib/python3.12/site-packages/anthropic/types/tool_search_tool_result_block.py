# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

from .._models import BaseModel
from .tool_search_tool_result_error import ToolSearchToolResultError
from .tool_search_tool_search_result_block import ToolSearchToolSearchResultBlock

__all__ = ["ToolSearchToolResultBlock", "Content"]

Content: TypeAlias = Union[ToolSearchToolResultError, ToolSearchToolSearchResultBlock]


class ToolSearchToolResultBlock(BaseModel):
    content: Content

    tool_use_id: str

    type: Literal["tool_search_tool_result"]
