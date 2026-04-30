# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

from .._models import BaseModel
from .text_editor_code_execution_tool_result_error import TextEditorCodeExecutionToolResultError
from .text_editor_code_execution_view_result_block import TextEditorCodeExecutionViewResultBlock
from .text_editor_code_execution_create_result_block import TextEditorCodeExecutionCreateResultBlock
from .text_editor_code_execution_str_replace_result_block import TextEditorCodeExecutionStrReplaceResultBlock

__all__ = ["TextEditorCodeExecutionToolResultBlock", "Content"]

Content: TypeAlias = Union[
    TextEditorCodeExecutionToolResultError,
    TextEditorCodeExecutionViewResultBlock,
    TextEditorCodeExecutionCreateResultBlock,
    TextEditorCodeExecutionStrReplaceResultBlock,
]


class TextEditorCodeExecutionToolResultBlock(BaseModel):
    content: Content

    tool_use_id: str

    type: Literal["text_editor_code_execution_tool_result"]
