# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_retry_status_retrying import BetaManagedAgentsRetryStatusRetrying
from .beta_managed_agents_retry_status_terminal import BetaManagedAgentsRetryStatusTerminal
from .beta_managed_agents_retry_status_exhausted import BetaManagedAgentsRetryStatusExhausted

__all__ = ["BetaManagedAgentsUnknownError", "RetryStatus"]

RetryStatus: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsRetryStatusRetrying,
        BetaManagedAgentsRetryStatusExhausted,
        BetaManagedAgentsRetryStatusTerminal,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsUnknownError(BaseModel):
    """An unknown or unexpected error occurred during session execution.

    A fallback variant; clients that don't recognize a new error code can match on `retry_status` and `message` alone.
    """

    message: str
    """Human-readable error description."""

    retry_status: RetryStatus
    """What the client should do next in response to this error."""

    type: Literal["unknown_error"]
