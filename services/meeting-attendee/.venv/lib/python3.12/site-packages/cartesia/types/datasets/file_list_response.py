# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ..._models import BaseModel

__all__ = ["FileListResponse"]


class FileListResponse(BaseModel):
    """File stored in a dataset"""

    id: str
    """Unique identifier for the file"""

    created_at: str
    """Timestamp when the file was created"""

    filename: str
    """Original filename"""

    size: int
    """Size of the file in bytes"""
