# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import TypedDict

from .pronunciation_dict_item_param import PronunciationDictItemParam

__all__ = ["PronunciationDictUpdateParams"]


class PronunciationDictUpdateParams(TypedDict, total=False):
    items: Optional[Iterable[PronunciationDictItemParam]]
    """Updated list of pronunciation mappings"""

    name: Optional[str]
    """New name for the pronunciation dictionary"""
