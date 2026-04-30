# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal, TypeAlias

__all__ = ["BetaWebSearchToolResultErrorCode"]

BetaWebSearchToolResultErrorCode: TypeAlias = Literal[
    "invalid_tool_input", "unavailable", "max_uses_exceeded", "too_many_requests", "query_too_long", "request_too_large"
]
