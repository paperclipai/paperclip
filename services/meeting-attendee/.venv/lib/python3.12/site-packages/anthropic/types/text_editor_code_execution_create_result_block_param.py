# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["TextEditorCodeExecutionCreateResultBlockParam"]


class TextEditorCodeExecutionCreateResultBlockParam(TypedDict, total=False):
    is_file_update: Required[bool]

    type: Required[Literal["text_editor_code_execution_create_result"]]
