# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["WebSearchResultBlock"]


class WebSearchResultBlock(BaseModel):
    encrypted_content: str

    page_age: Optional[str] = None

    title: str

    type: Literal["web_search_result"]

    url: str
