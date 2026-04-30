# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, TypedDict

__all__ = ["VoiceGetParams"]


class VoiceGetParams(TypedDict, total=False):
    expand: Optional[List[Literal["preview_file_url"]]]
    """Additional fields to include in the response."""
