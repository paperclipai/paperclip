# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsAlwaysAskPolicy"]


class BetaManagedAgentsAlwaysAskPolicy(BaseModel):
    """Tool calls require user confirmation before execution."""

    type: Literal["always_ask"]
