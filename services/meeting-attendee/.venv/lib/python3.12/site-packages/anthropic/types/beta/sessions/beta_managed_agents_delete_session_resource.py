# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsDeleteSessionResource"]


class BetaManagedAgentsDeleteSessionResource(BaseModel):
    """Confirmation of resource deletion."""

    id: str

    type: Literal["session_resource_deleted"]
