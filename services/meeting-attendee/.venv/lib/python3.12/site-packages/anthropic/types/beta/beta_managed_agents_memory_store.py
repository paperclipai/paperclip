# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Optional
from datetime import datetime
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaManagedAgentsMemoryStore"]


class BetaManagedAgentsMemoryStore(BaseModel):
    id: str

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    name: str

    type: Literal["memory_store"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""

    archived_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""

    description: Optional[str] = None

    metadata: Optional[Dict[str, str]] = None
