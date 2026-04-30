# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal, TypeAlias

__all__ = ["TextEditorCodeExecutionToolResultErrorCode"]

TextEditorCodeExecutionToolResultErrorCode: TypeAlias = Literal[
    "invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded", "file_not_found"
]
