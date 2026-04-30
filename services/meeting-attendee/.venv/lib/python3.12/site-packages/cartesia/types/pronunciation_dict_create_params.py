# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import Required, TypedDict

from .pronunciation_dict_item_param import PronunciationDictItemParam

__all__ = ["PronunciationDictCreateParams"]


class PronunciationDictCreateParams(TypedDict, total=False):
    name: Required[str]
    """Name for the new pronunciation dictionary"""

    items: Optional[Iterable[PronunciationDictItemParam]]
    """Optional initial list of pronunciation mappings"""
