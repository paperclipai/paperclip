# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_file_scope import BetaFileScope

__all__ = ["FileMetadata"]


class FileMetadata(BaseModel):
    id: str
    """Unique object identifier.

    The format and length of IDs may change over time.
    """

    created_at: datetime
    """RFC 3339 datetime string representing when the file was created."""

    filename: str
    """Original filename of the uploaded file."""

    mime_type: str
    """MIME type of the file."""

    size_bytes: int
    """Size of the file in bytes."""

    type: Literal["file"]
    """Object type.

    For files, this is always `"file"`.
    """

    downloadable: Optional[bool] = None
    """Whether the file can be downloaded."""

    scope: Optional[BetaFileScope] = None
    """
    The scope of this file, indicating the context in which it was created (e.g., a
    session).
    """
