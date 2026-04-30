# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaBashCodeExecutionToolResultErrorParam"]


class BetaBashCodeExecutionToolResultErrorParam(TypedDict, total=False):
    error_code: Required[
        Literal[
            "invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded", "output_file_too_large"
        ]
    ]

    type: Required[Literal["bash_code_execution_tool_result_error"]]
