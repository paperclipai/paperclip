# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaTextEditorCodeExecutionViewResultBlock"]


class BetaTextEditorCodeExecutionViewResultBlock(BaseModel):
    content: str

    file_type: Literal["text", "image", "pdf"]

    num_lines: Optional[int] = None

    start_line: Optional[int] = None

    total_lines: Optional[int] = None

    type: Literal["text_editor_code_execution_view_result"]
