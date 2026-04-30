# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsRetryStatusRetrying"]


class BetaManagedAgentsRetryStatusRetrying(BaseModel):
    """The server is retrying automatically.

    Client should wait; the same error type may fire again as retrying, then once as exhausted when the retry budget runs out.
    """

    type: Literal["retrying"]
