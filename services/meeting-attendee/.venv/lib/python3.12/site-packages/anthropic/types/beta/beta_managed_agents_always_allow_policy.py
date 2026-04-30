# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsAlwaysAllowPolicy"]


class BetaManagedAgentsAlwaysAllowPolicy(BaseModel):
    """Tool calls are automatically approved without user confirmation."""

    type: Literal["always_allow"]
