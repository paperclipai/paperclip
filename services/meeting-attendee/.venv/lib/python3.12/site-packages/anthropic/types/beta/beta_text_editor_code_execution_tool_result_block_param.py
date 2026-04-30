# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_text_editor_code_execution_tool_result_error_param import BetaTextEditorCodeExecutionToolResultErrorParam
from .beta_text_editor_code_execution_view_result_block_param import BetaTextEditorCodeExecutionViewResultBlockParam
from .beta_text_editor_code_execution_create_result_block_param import BetaTextEditorCodeExecutionCreateResultBlockParam
from .beta_text_editor_code_execution_str_replace_result_block_param import (
    BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
)

__all__ = ["BetaTextEditorCodeExecutionToolResultBlockParam", "Content"]

Content: TypeAlias = Union[
    BetaTextEditorCodeExecutionToolResultErrorParam,
    BetaTextEditorCodeExecutionViewResultBlockParam,
    BetaTextEditorCodeExecutionCreateResultBlockParam,
    BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
]


class BetaTextEditorCodeExecutionToolResultBlockParam(TypedDict, total=False):
    content: Required[Content]

    tool_use_id: Required[str]

    type: Required[Literal["text_editor_code_execution_tool_result"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
