# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsRetryStatusTerminal"]


class BetaManagedAgentsRetryStatusTerminal(BaseModel):
    """
    The session encountered a terminal error and will transition to `terminated` state.
    """

    type: Literal["terminal"]
