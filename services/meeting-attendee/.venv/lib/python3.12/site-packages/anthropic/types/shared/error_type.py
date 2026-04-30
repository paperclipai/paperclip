# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal, TypeAlias

__all__ = ["ErrorType"]

ErrorType: TypeAlias = Literal[
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "not_found_error",
    "rate_limit_error",
    "timeout_error",
    "overloaded_error",
    "api_error",
    "billing_error",
]
