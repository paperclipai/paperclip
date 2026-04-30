# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .beta_web_fetch_tool_result_error_code import BetaWebFetchToolResultErrorCode

__all__ = ["BetaWebFetchToolResultErrorBlockParam"]


class BetaWebFetchToolResultErrorBlockParam(TypedDict, total=False):
    error_code: Required[BetaWebFetchToolResultErrorCode]

    type: Required[Literal["web_fetch_tool_result_error"]]
