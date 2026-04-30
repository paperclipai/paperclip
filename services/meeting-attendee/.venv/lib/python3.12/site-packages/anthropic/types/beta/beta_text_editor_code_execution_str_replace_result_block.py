# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaTextEditorCodeExecutionStrReplaceResultBlock"]


class BetaTextEditorCodeExecutionStrReplaceResultBlock(BaseModel):
    lines: Optional[List[str]] = None

    new_lines: Optional[int] = None

    new_start: Optional[int] = None

    old_lines: Optional[int] = None

    old_start: Optional[int] = None

    type: Literal["text_editor_code_execution_str_replace_result"]
