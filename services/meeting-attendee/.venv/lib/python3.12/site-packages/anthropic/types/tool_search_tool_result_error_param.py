# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .tool_search_tool_result_error_code import ToolSearchToolResultErrorCode

__all__ = ["ToolSearchToolResultErrorParam"]


class ToolSearchToolResultErrorParam(TypedDict, total=False):
    error_code: Required[ToolSearchToolResultErrorCode]

    type: Required[Literal["tool_search_tool_result_error"]]
