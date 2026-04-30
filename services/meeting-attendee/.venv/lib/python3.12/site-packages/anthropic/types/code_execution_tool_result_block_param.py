# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .cache_control_ephemeral_param import CacheControlEphemeralParam
from .code_execution_tool_result_block_param_content_param import CodeExecutionToolResultBlockParamContentParam

__all__ = ["CodeExecutionToolResultBlockParam"]


class CodeExecutionToolResultBlockParam(TypedDict, total=False):
    content: Required[CodeExecutionToolResultBlockParamContentParam]
    """Code execution result with encrypted stdout for PFC + web_search results."""

    tool_use_id: Required[str]

    type: Required[Literal["code_execution_tool_result"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
