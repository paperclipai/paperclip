# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["CitationSearchResultLocationParam"]


class CitationSearchResultLocationParam(TypedDict, total=False):
    cited_text: Required[str]

    end_block_index: Required[int]

    search_result_index: Required[int]

    source: Required[str]

    start_block_index: Required[int]

    title: Required[Optional[str]]

    type: Required[Literal["search_result_location"]]
