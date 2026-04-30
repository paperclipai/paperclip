# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["CitationCharLocation"]


class CitationCharLocation(BaseModel):
    cited_text: str

    document_index: int

    document_title: Optional[str] = None

    end_char_index: int

    file_id: Optional[str] = None

    start_char_index: int

    type: Literal["char_location"]
