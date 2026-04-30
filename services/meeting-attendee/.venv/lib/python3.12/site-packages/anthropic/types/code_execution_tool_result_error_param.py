# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .code_execution_tool_result_error_code import CodeExecutionToolResultErrorCode

__all__ = ["CodeExecutionToolResultErrorParam"]


class CodeExecutionToolResultErrorParam(TypedDict, total=False):
    error_code: Required[CodeExecutionToolResultErrorCode]

    type: Required[Literal["code_execution_tool_result_error"]]
