# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

from ..._models import BaseModel
from .beta_text_editor_code_execution_tool_result_error import BetaTextEditorCodeExecutionToolResultError
from .beta_text_editor_code_execution_view_result_block import BetaTextEditorCodeExecutionViewResultBlock
from .beta_text_editor_code_execution_create_result_block import BetaTextEditorCodeExecutionCreateResultBlock
from .beta_text_editor_code_execution_str_replace_result_block import BetaTextEditorCodeExecutionStrReplaceResultBlock

__all__ = ["BetaTextEditorCodeExecutionToolResultBlock", "Content"]

Content: TypeAlias = Union[
    BetaTextEditorCodeExecutionToolResultError,
    BetaTextEditorCodeExecutionViewResultBlock,
    BetaTextEditorCodeExecutionCreateResultBlock,
    BetaTextEditorCodeExecutionStrReplaceResultBlock,
]


class BetaTextEditorCodeExecutionToolResultBlock(BaseModel):
    content: Content

    tool_use_id: str

    type: Literal["text_editor_code_execution_tool_result"]
