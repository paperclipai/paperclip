# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["TextEditorCodeExecutionViewResultBlockParam"]


class TextEditorCodeExecutionViewResultBlockParam(TypedDict, total=False):
    content: Required[str]

    file_type: Required[Literal["text", "image", "pdf"]]

    type: Required[Literal["text_editor_code_execution_view_result"]]

    num_lines: Optional[int]

    start_line: Optional[int]

    total_lines: Optional[int]
