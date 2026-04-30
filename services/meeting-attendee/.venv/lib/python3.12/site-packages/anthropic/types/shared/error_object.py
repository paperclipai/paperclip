# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ..._utils import PropertyInfo
from .billing_error import BillingError
from .not_found_error import NotFoundError
from .api_error_object import APIErrorObject
from .overloaded_error import OverloadedError
from .permission_error import PermissionError
from .rate_limit_error import RateLimitError
from .authentication_error import AuthenticationError
from .gateway_timeout_error import GatewayTimeoutError
from .invalid_request_error import InvalidRequestError

__all__ = ["ErrorObject"]

ErrorObject: TypeAlias = Annotated[
    Union[
        InvalidRequestError,
        AuthenticationError,
        BillingError,
        PermissionError,
        NotFoundError,
        RateLimitError,
        GatewayTimeoutError,
        APIErrorObject,
        OverloadedError,
    ],
    PropertyInfo(discriminator="type"),
]
