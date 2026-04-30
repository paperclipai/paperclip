# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from ..._types import SequenceNotStr

__all__ = ["BetaTextEditorCodeExecutionStrReplaceResultBlockParam"]


class BetaTextEditorCodeExecutionStrReplaceResultBlockParam(TypedDict, total=False):
    type: Required[Literal["text_editor_code_execution_str_replace_result"]]

    lines: Optional[SequenceNotStr[str]]

    new_lines: Optional[int]

    new_start: Optional[int]

    old_lines: Optional[int]

    old_start: Optional[int]
