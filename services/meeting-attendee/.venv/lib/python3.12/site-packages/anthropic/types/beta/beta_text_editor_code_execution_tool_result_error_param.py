# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaTextEditorCodeExecutionToolResultErrorParam"]


class BetaTextEditorCodeExecutionToolResultErrorParam(TypedDict, total=False):
    error_code: Required[
        Literal["invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded", "file_not_found"]
    ]

    type: Required[Literal["text_editor_code_execution_tool_result_error"]]

    error_message: Optional[str]
