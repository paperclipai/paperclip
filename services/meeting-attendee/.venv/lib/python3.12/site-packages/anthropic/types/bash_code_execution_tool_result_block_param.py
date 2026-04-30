# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .cache_control_ephemeral_param import CacheControlEphemeralParam
from .bash_code_execution_result_block_param import BashCodeExecutionResultBlockParam
from .bash_code_execution_tool_result_error_param import BashCodeExecutionToolResultErrorParam

__all__ = ["BashCodeExecutionToolResultBlockParam", "Content"]

Content: TypeAlias = Union[BashCodeExecutionToolResultErrorParam, BashCodeExecutionResultBlockParam]


class BashCodeExecutionToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["bash_code_execution_tool_result"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
