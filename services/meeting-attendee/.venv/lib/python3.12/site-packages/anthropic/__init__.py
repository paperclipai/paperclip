# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import typing as _t

from . import types
from ._types import NOT_GIVEN, Omit, NoneType, NotGiven, Transport, ProxiesTypes, omit, not_given
from ._utils import file_from_path
from ._client import (
    Client,
    Stream,
    Timeout,
    Anthropic,
    Transport,
    AsyncClient,
    AsyncStream,
    AsyncAnthropic,
    RequestOptions,
)
from ._models import BaseModel
from ._version import __title__, __version__
from ._response import APIResponse as APIResponse, AsyncAPIResponse as AsyncAPIResponse
from ._constants import (
    AI_PROMPT as AI_PROMPT,
    HUMAN_PROMPT as HUMAN_PROMPT,
    DEFAULT_TIMEOUT,
    DEFAULT_MAX_RETRIES,
    DEFAULT_CONNECTION_LIMITS,
)
from ._exceptions import (
    APIError,
    ConflictError,
    NotFoundError,
    AnthropicError,
    APIStatusError,
    RateLimitError,
    APITimeoutError,
    BadRequestError,
    APIConnectionError,
    AuthenticationError,
    InternalServerError,
    PermissionDeniedError,
    UnprocessableEntityError,
    APIResponseValidationError,
)
from ._base_client import DefaultHttpxClient, DefaultAioHttpClient, DefaultAsyncHttpxClient
from ._utils._logs import setup_logging as _setup_logging
from .lib._parse._transform import transform_schema

__all__ = [
    "types",
    "__version__",
    "__title__",
    "NoneType",
    "Transport",
    "ProxiesTypes",
    "NotGiven",
    "NOT_GIVEN",
    "not_given",
    "Omit",
    "omit",
    "AnthropicError",
    "APIError",
    "APIStatusError",
    "APITimeoutError",
    "APIConnectionError",
    "APIResponseValidationError",
    "BadRequestError",
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "UnprocessableEntityError",
    "RateLimitError",
    "InternalServerError",
    "Timeout",
    "RequestOptions",
    "Client",
    "AsyncClient",
    "Stream",
    "AsyncStream",
    "Anthropic",
    "AsyncAnthropic",
    "file_from_path",
    "BaseModel",
    "DEFAULT_TIMEOUT",
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_CONNECTION_LIMITS",
    "DefaultHttpxClient",
    "DefaultAsyncHttpxClient",
    "DefaultAioHttpClient",
    "HUMAN_PROMPT",
    "AI_PROMPT",
    "beta_tool",
    "beta_async_tool",
    "transform_schema",
]

if not _t.TYPE_CHECKING:
    from ._utils._resources_proxy import resources as resources

from .lib.aws import AnthropicAWS as AnthropicAWS, AsyncAnthropicAWS as AsyncAnthropicAWS
from .lib.tools import beta_tool, beta_async_tool
from .lib.vertex import *
from .lib.bedrock import *
from .lib.foundry import AnthropicFoundry as AnthropicFoundry, AsyncAnthropicFoundry as AsyncAnthropicFoundry
from .lib.streaming import *

_setup_logging()

# Update the __module__ attribute for exported symbols so that
# error messages point to this module instead of the module
# it was originally defined in, e.g.
# anthropic._exceptions.NotFoundError -> anthropic.NotFoundError
__locals = locals()
for __name in __all__:
    if not __name.startswith("__"):
        try:
            __locals[__name].__module__ = "anthropic"
        except (TypeError, AttributeError):
            # Some of our exported symbols are builtins which we can't set attributes for.
            pass
