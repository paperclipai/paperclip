# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_retry_status_retrying import BetaManagedAgentsRetryStatusRetrying
from .beta_managed_agents_retry_status_terminal import BetaManagedAgentsRetryStatusTerminal
from .beta_managed_agents_retry_status_exhausted import BetaManagedAgentsRetryStatusExhausted

__all__ = ["BetaManagedAgentsBillingError", "RetryStatus"]

RetryStatus: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsRetryStatusRetrying,
        BetaManagedAgentsRetryStatusExhausted,
        BetaManagedAgentsRetryStatusTerminal,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsBillingError(BaseModel):
    """
    The caller's organization or workspace cannot make model requests — out of credits or spend limit reached. Retrying with the same credentials will not succeed; the caller must resolve the billing state.
    """

    message: str
    """Human-readable error description."""

    retry_status: RetryStatus
    """What the client should do next in response to this error."""

    type: Literal["billing_error"]
