# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from .._utils import PropertyInfo
from .beta_api_error import BetaAPIError
from .beta_billing_error import BetaBillingError
from .beta_not_found_error import BetaNotFoundError
from .beta_overloaded_error import BetaOverloadedError
from .beta_permission_error import BetaPermissionError
from .beta_rate_limit_error import BetaRateLimitError
from .beta_authentication_error import BetaAuthenticationError
from .beta_gateway_timeout_error import BetaGatewayTimeoutError
from .beta_invalid_request_error import BetaInvalidRequestError

__all__ = ["BetaError"]

BetaError: TypeAlias = Annotated[
    Union[
        BetaInvalidRequestError,
        BetaAuthenticationError,
        BetaBillingError,
        BetaPermissionError,
        BetaNotFoundError,
        BetaRateLimitError,
        BetaGatewayTimeoutError,
        BetaAPIError,
        BetaOverloadedError,
    ],
    PropertyInfo(discriminator="type"),
]
