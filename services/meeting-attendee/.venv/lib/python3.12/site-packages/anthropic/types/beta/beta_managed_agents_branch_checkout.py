# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsBranchCheckout"]


class BetaManagedAgentsBranchCheckout(BaseModel):
    name: str
    """Branch name to check out."""

    type: Literal["branch"]
