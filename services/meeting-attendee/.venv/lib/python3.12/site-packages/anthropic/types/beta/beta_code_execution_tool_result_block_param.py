# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_code_execution_tool_result_block_param_content_param import BetaCodeExecutionToolResultBlockParamContentParam

__all__ = ["BetaCodeExecutionToolResultBlockParam"]


class BetaCodeExecutionToolResultBlockParam(TypedDict, total=False):
    content: Required[BetaCodeExecutionToolResultBlockParamContentParam]
    """Code execution result with encrypted stdout for PFC + web_search results."""

    tool_use_id: Required[str]

    type: Required[Literal["code_execution_tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
