# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_bash_code_execution_result_block_param import BetaBashCodeExecutionResultBlockParam
from .beta_bash_code_execution_tool_result_error_param import BetaBashCodeExecutionToolResultErrorParam

__all__ = ["BetaBashCodeExecutionToolResultBlockParam", "Content"]

Content: TypeAlias = Union[BetaBashCodeExecutionToolResultErrorParam, BetaBashCodeExecutionResultBlockParam]


class BetaBashCodeExecutionToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["bash_code_execution_tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
