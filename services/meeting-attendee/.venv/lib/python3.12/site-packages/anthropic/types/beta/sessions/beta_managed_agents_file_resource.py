# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsFileResource"]


class BetaManagedAgentsFileResource(BaseModel):
    id: str

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    file_id: str

    mount_path: str

    type: Literal["file"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""
