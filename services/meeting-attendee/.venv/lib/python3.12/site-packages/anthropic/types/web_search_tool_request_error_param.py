# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .web_search_tool_result_error_code import WebSearchToolResultErrorCode

__all__ = ["WebSearchToolRequestErrorParam"]


class WebSearchToolRequestErrorParam(TypedDict, total=False):
    error_code: Required[WebSearchToolResultErrorCode]

    type: Required[Literal["web_search_tool_result_error"]]
