# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsDeletedCredential"]


class BetaManagedAgentsDeletedCredential(BaseModel):
    """Confirmation of a deleted credential."""

    id: str
    """Unique identifier of the deleted credential."""

    type: Literal["vault_credential_deleted"]
