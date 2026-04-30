# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["CitationWebSearchResultLocationParam"]


class CitationWebSearchResultLocationParam(TypedDict, total=False):
    cited_text: Required[str]

    encrypted_index: Required[str]

    title: Required[Optional[str]]

    type: Required[Literal["web_search_result_location"]]

    url: Required[str]
