# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .cache_control_ephemeral_param import CacheControlEphemeralParam
from .text_editor_code_execution_tool_result_error_param import TextEditorCodeExecutionToolResultErrorParam
from .text_editor_code_execution_view_result_block_param import TextEditorCodeExecutionViewResultBlockParam
from .text_editor_code_execution_create_result_block_param import TextEditorCodeExecutionCreateResultBlockParam
from .text_editor_code_execution_str_replace_result_block_param import TextEditorCodeExecutionStrReplaceResultBlockParam

__all__ = ["TextEditorCodeExecutionToolResultBlockParam", "Content"]

Content: TypeAlias = Union[
    TextEditorCodeExecutionToolResultErrorParam,
    TextEditorCodeExecutionViewResultBlockParam,
    TextEditorCodeExecutionCreateResultBlockParam,
    TextEditorCodeExecutionStrReplaceResultBlockParam,
]


class TextEditorCodeExecutionToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["text_editor_code_execution_tool_result"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
