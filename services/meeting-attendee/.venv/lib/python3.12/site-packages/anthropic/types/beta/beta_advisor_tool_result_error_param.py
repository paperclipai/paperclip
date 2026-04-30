# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaAdvisorToolResultErrorParam"]


class BetaAdvisorToolResultErrorParam(TypedDict, total=False):
    error_code: Required[
        Literal[
            "max_uses_exceeded",
            "prompt_too_long",
            "too_many_requests",
            "overloaded",
            "unavailable",
            "execution_time_exceeded",
        ]
    ]

    type: Required[Literal["advisor_tool_result_error"]]
