# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["CitationsSearchResultLocation"]


class CitationsSearchResultLocation(BaseModel):
    cited_text: str

    end_block_index: int

    search_result_index: int

    source: str

    start_block_index: int

    title: Optional[str] = None

    type: Literal["search_result_location"]
