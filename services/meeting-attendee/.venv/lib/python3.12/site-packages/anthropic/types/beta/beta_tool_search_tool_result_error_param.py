# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaToolSearchToolResultErrorParam"]


class BetaToolSearchToolResultErrorParam(TypedDict, total=False):
    error_code: Required[Literal["invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded"]]

    type: Required[Literal["tool_search_tool_result_error"]]
