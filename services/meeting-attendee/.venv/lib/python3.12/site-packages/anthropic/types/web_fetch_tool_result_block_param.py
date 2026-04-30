# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .direct_caller_param import DirectCallerParam
from .web_fetch_block_param import WebFetchBlockParam
from .server_tool_caller_param import ServerToolCallerParam
from .cache_control_ephemeral_param import CacheControlEphemeralParam
from .server_tool_caller_20260120_param import ServerToolCaller20260120Param
from .web_fetch_tool_result_error_block_param import WebFetchToolResultErrorBlockParam

__all__ = ["WebFetchToolResultBlockParam", "Content", "Caller"]

Content: TypeAlias = Union[WebFetchToolResultErrorBlockParam, WebFetchBlockParam]

Caller: TypeAlias = Union[DirectCallerParam, ServerToolCallerParam, ServerToolCaller20260120Param]


class WebFetchToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["web_fetch_tool_result"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    caller: Caller
    """Tool invocation directly from the model."""
