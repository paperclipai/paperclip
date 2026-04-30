# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaCitationPageLocationParam"]


class BetaCitationPageLocationParam(TypedDict, total=False):
    cited_text: Required[str]

    document_index: Required[int]

    document_title: Required[Optional[str]]

    end_page_number: Required[int]

    start_page_number: Required[int]

    type: Required[Literal["page_location"]]
