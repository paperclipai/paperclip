# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["CitationsWebSearchResultLocation"]


class CitationsWebSearchResultLocation(BaseModel):
    cited_text: str

    encrypted_index: str

    title: Optional[str] = None

    type: Literal["web_search_result_location"]

    url: str
