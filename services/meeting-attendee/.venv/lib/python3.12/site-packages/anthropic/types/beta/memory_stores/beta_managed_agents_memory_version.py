# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel
from .beta_managed_agents_actor import BetaManagedAgentsActor
from .beta_managed_agents_memory_version_operation import BetaManagedAgentsMemoryVersionOperation

__all__ = ["BetaManagedAgentsMemoryVersion"]


class BetaManagedAgentsMemoryVersion(BaseModel):
    id: str

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    memory_id: str

    memory_store_id: str

    operation: BetaManagedAgentsMemoryVersionOperation
    """MemoryVersionOperation enum"""

    type: Literal["memory_version"]

    content: Optional[str] = None

    content_sha256: Optional[str] = None

    content_size_bytes: Optional[int] = None

    created_by: Optional[BetaManagedAgentsActor] = None

    path: Optional[str] = None

    redacted_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""

    redacted_by: Optional[BetaManagedAgentsActor] = None
