# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsTokenEndpointAuthNoneResponse"]


class BetaManagedAgentsTokenEndpointAuthNoneResponse(BaseModel):
    """Token endpoint requires no client authentication."""

    type: Literal["none"]
