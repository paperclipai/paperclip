# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .text_editor_code_execution_tool_result_error_code import TextEditorCodeExecutionToolResultErrorCode

__all__ = ["TextEditorCodeExecutionToolResultErrorParam"]


class TextEditorCodeExecutionToolResultErrorParam(TypedDict, total=False):
    error_code: Required[TextEditorCodeExecutionToolResultErrorCode]

    type: Required[Literal["text_editor_code_execution_tool_result_error"]]

    error_message: Optional[str]
