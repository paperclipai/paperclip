# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal, TypeAlias

__all__ = ["WebFetchToolResultErrorCode"]

WebFetchToolResultErrorCode: TypeAlias = Literal[
    "invalid_tool_input",
    "url_too_long",
    "url_not_allowed",
    "url_not_accessible",
    "unsupported_content_type",
    "too_many_requests",
    "max_uses_exceeded",
    "unavailable",
]
