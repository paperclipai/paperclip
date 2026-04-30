# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_direct_caller_param import BetaDirectCallerParam
from .beta_server_tool_caller_param import BetaServerToolCallerParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_server_tool_caller_20260120_param import BetaServerToolCaller20260120Param
from .beta_web_search_tool_result_block_param_content_param import BetaWebSearchToolResultBlockParamContentParam

__all__ = ["BetaWebSearchToolResultBlockParam", "Caller"]

Caller: TypeAlias = Union[BetaDirectCallerParam, BetaServerToolCallerParam, BetaServerToolCaller20260120Param]


class BetaWebSearchToolResultBlockParam(TypedDict, total=False):
    content: Required[BetaWebSearchToolResultBlockParamContentParam]

    tool_use_id: Required[str]

    type: Required[Literal["web_search_tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    caller: Caller
    """Tool invocation directly from the model."""
