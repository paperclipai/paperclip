# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .web_fetch_tool_result_error_code import WebFetchToolResultErrorCode

__all__ = ["WebFetchToolResultErrorBlockParam"]


class WebFetchToolResultErrorBlockParam(TypedDict, total=False):
    error_code: Required[WebFetchToolResultErrorCode]

    type: Required[Literal["web_fetch_tool_result_error"]]
