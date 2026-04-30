# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List

from .._models import BaseModel
from .pronunciation_dict_item import PronunciationDictItem

__all__ = ["PronunciationDict"]


class PronunciationDict(BaseModel):
    """A dictionary of text-to-alias mappings"""

    id: str
    """Unique identifier for the pronunciation dictionary"""

    created_at: str
    """ISO 8601 timestamp of when the dictionary was created"""

    items: List[PronunciationDictItem]
    """List of text-to-pronunciation mappings"""

    name: str
    """Name of the pronunciation dictionary"""

    owner_id: str
    """ID of the user who owns this dictionary"""

    pinned: bool
    """Whether this dictionary is pinned for the user"""
