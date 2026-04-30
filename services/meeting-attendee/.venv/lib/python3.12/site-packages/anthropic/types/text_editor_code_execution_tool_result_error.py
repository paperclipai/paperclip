# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel
from .text_editor_code_execution_tool_result_error_code import TextEditorCodeExecutionToolResultErrorCode

__all__ = ["TextEditorCodeExecutionToolResultError"]


class TextEditorCodeExecutionToolResultError(BaseModel):
    error_code: TextEditorCodeExecutionToolResultErrorCode

    error_message: Optional[str] = None

    type: Literal["text_editor_code_execution_tool_result_error"]
