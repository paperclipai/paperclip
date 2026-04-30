# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .beta_code_execution_tool_result_error_code import BetaCodeExecutionToolResultErrorCode

__all__ = ["BetaCodeExecutionToolResultErrorParam"]


class BetaCodeExecutionToolResultErrorParam(TypedDict, total=False):
    error_code: Required[BetaCodeExecutionToolResultErrorCode]

    type: Required[Literal["code_execution_tool_result_error"]]
