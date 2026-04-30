# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .direct_caller_param import DirectCallerParam
from .server_tool_caller_param import ServerToolCallerParam
from .cache_control_ephemeral_param import CacheControlEphemeralParam
from .server_tool_caller_20260120_param import ServerToolCaller20260120Param

__all__ = ["ServerToolUseBlockParam", "Caller"]

Caller: TypeAlias = Union[DirectCallerParam, ServerToolCallerParam, ServerToolCaller20260120Param]


class ServerToolUseBlockParam(TypedDict, total=False):
    id: Required[str]

    input: Required[Dict[str, object]]

    name: Required[
        Literal[
            "web_search",
            "web_fetch",
            "code_execution",
            "bash_code_execution",
            "text_editor_code_execution",
            "tool_search_tool_regex",
            "tool_search_tool_bm25",
        ]
    ]

    type: Required[Literal["server_tool_use"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    caller: Caller
    """Tool invocation directly from the model."""
