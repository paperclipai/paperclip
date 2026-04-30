# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_direct_caller_param import BetaDirectCallerParam
from .beta_server_tool_caller_param import BetaServerToolCallerParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_server_tool_caller_20260120_param import BetaServerToolCaller20260120Param

__all__ = ["BetaServerToolUseBlockParam", "Caller"]

Caller: TypeAlias = Union[BetaDirectCallerParam, BetaServerToolCallerParam, BetaServerToolCaller20260120Param]


class BetaServerToolUseBlockParam(TypedDict, total=False):
    id: Required[str]

    input: Required[Dict[str, object]]

    name: Required[
        Literal[
            "advisor",
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

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""

    caller: Caller
    """Tool invocation directly from the model."""
