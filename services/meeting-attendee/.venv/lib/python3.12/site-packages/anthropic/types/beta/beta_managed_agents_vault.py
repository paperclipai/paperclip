# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Optional
from datetime import datetime
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsVault"]


class BetaManagedAgentsVault(BaseModel):
    """A vault that stores credentials for use by agents during sessions."""

    id: str
    """Unique identifier for the vault."""

    archived_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    display_name: str
    """Human-readable name for the vault."""

    metadata: Dict[str, str]
    """Arbitrary key-value metadata attached to the vault."""

    type: Literal["vault"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""
