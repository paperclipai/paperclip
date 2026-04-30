# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .bash_code_execution_tool_result_error_code import BashCodeExecutionToolResultErrorCode

__all__ = ["BashCodeExecutionToolResultErrorParam"]


class BashCodeExecutionToolResultErrorParam(TypedDict, total=False):
    error_code: Required[BashCodeExecutionToolResultErrorCode]

    type: Required[Literal["bash_code_execution_tool_result_error"]]
