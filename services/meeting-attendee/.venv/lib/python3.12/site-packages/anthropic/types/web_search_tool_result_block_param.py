# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .direct_caller_param import DirectCallerParam
from .server_tool_caller_param import ServerToolCallerParam
from .cache_control_ephemeral_param import CacheControlEphemeralParam
from .server_tool_caller_20260120_param import ServerToolCaller20260120Param
from .web_search_tool_result_block_param_content_param import WebSearchToolResultBlockParamContentParam

__all__ = ["WebSearchToolResultBlockParam", "Caller"]

Caller: TypeAlias = Union[DirectCallerParam, ServerToolCallerParam, ServerToolCaller20260120Param]


class WebSearchToolResultBlockParam(TypedDict, total=False):
    content: Required[WebSearchToolResultBlockParamContentParam]

    tool_use_id: Required[str]

    type: Required[Literal["web_search_tool_result"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    caller: Caller
    """Tool invocation directly from the model."""
