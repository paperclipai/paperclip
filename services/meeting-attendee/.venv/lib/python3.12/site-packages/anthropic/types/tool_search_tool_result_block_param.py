# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .cache_control_ephemeral_param import CacheControlEphemeralParam
from .tool_search_tool_result_error_param import ToolSearchToolResultErrorParam
from .tool_search_tool_search_result_block_param import ToolSearchToolSearchResultBlockParam

__all__ = ["ToolSearchToolResultBlockParam", "Content"]

Content: TypeAlias = Union[ToolSearchToolResultErrorParam, ToolSearchToolSearchResultBlockParam]


class ToolSearchToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["tool_search_tool_result"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
