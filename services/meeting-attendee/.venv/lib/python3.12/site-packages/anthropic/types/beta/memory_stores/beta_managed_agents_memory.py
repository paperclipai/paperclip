# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsMemory"]


class BetaManagedAgentsMemory(BaseModel):
    id: str

    content_sha256: str

    content_size_bytes: int

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    memory_store_id: str

    memory_version_id: str

    path: str

    type: Literal["memory"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""

    content: Optional[str] = None
