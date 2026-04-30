# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaTextEditorCodeExecutionToolResultError"]


class BetaTextEditorCodeExecutionToolResultError(BaseModel):
    error_code: Literal[
        "invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded", "file_not_found"
    ]

    error_message: Optional[str] = None

    type: Literal["text_editor_code_execution_tool_result_error"]
