# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["DeletedFile"]


class DeletedFile(BaseModel):
    id: str
    """ID of the deleted file."""

    type: Optional[Literal["file_deleted"]] = None
    """Deleted object type.

    For file deletion, this is always `"file_deleted"`.
    """
