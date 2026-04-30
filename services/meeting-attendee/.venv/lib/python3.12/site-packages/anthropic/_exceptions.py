# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, cast
from typing_extensions import Literal

import httpx

from ._utils import is_dict
from .types.shared.error_type import ErrorType

__all__ = [
    "BadRequestError",
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "UnprocessableEntityError",
    "RateLimitError",
    "InternalServerError",
]


class AnthropicError(Exception):
    pass


class APIError(AnthropicError):
    message: str
    request: httpx.Request

    body: object | None
    """The API response body.

    If the API responded with a valid JSON structure then this property will be the
    decoded result.

    If it isn't a valid JSON structure then this will be the raw response.

    If there was no response associated with this error then it will be `None`.
    """

    def __init__(self, message: str, request: httpx.Request, *, body: object | None) -> None:  # noqa: ARG002
        super().__init__(message)
        self.request = request
        self.message = message
        self.body = body


class APIResponseValidationError(APIError):
    response: httpx.Response
    status_code: int

    def __init__(self, response: httpx.Response, body: object | None, *, message: str | None = None) -> None:
        super().__init__(message or "Data returned by API invalid for expected schema.", response.request, body=body)
        self.response = response
        self.status_code = response.status_code


class APIStatusError(APIError):
    """Raised when an API response has a status code of 4xx or 5xx."""

    response: httpx.Response
    status_code: int
    request_id: str | None
    type: ErrorType | None

    def __init__(self, message: str, *, response: httpx.Response, body: object | None) -> None:
        super().__init__(message, response.request, body=body)
        self.response = response
        self.status_code = response.status_code
        self.request_id = response.headers.get("request-id")

        self.type = None
        if is_dict(body):
            error = body.get("error")
            if is_dict(error):
                self.type = cast(Union[ErrorType, None], error.get("type"))


class APIConnectionError(APIError):
    def __init__(self, *, message: str = "Connection error.", request: httpx.Request) -> None:
        super().__init__(message, request, body=None)


class APITimeoutError(APIConnectionError):
    def __init__(self, request: httpx.Request) -> None:
        super().__init__(
            message="Request timed out or interrupted. This could be due to a network timeout, dropped connection, or request cancellation. See https://docs.anthropic.com/en/api/errors#long-requests for more details.",
            request=request,
        )


class BadRequestError(APIStatusError):
    status_code: Literal[400] = 400  # pyright: ignore[reportIncompatibleVariableOverride]


class AuthenticationError(APIStatusError):
    status_code: Literal[401] = 401  # pyright: ignore[reportIncompatibleVariableOverride]


class PermissionDeniedError(APIStatusError):
    status_code: Literal[403] = 403  # pyright: ignore[reportIncompatibleVariableOverride]


class NotFoundError(APIStatusError):
    status_code: Literal[404] = 404  # pyright: ignore[reportIncompatibleVariableOverride]


class ConflictError(APIStatusError):
    status_code: Literal[409] = 409  # pyright: ignore[reportIncompatibleVariableOverride]


class RequestTooLargeError(APIStatusError):
    status_code: Literal[413] = 413  # pyright: ignore[reportIncompatibleVariableOverride]


class UnprocessableEntityError(APIStatusError):
    status_code: Literal[422] = 422  # pyright: ignore[reportIncompatibleVariableOverride]


class RateLimitError(APIStatusError):
    status_code: Literal[429] = 429  # pyright: ignore[reportIncompatibleVariableOverride]


class ServiceUnavailableError(APIStatusError):
    status_code: Literal[503] = 503  # pyright: ignore[reportIncompatibleVariableOverride]


class OverloadedError(APIStatusError):
    status_code: Literal[529] = 529  # pyright: ignore[reportIncompatibleVariableOverride]


class DeadlineExceededError(APIStatusError):
    status_code: Literal[504] = 504  # pyright: ignore[reportIncompatibleVariableOverride]


class InternalServerError(APIStatusError):
    pass
