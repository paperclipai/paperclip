# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .document_block_param import DocumentBlockParam

__all__ = ["WebFetchBlockParam"]


class WebFetchBlockParam(TypedDict, total=False):
    content: Required[DocumentBlockParam]

    type: Required[Literal["web_fetch_result"]]

    url: Required[str]
    """Fetched content URL"""

    retrieved_at: Optional[str]
    """ISO 8601 timestamp when the content was retrieved"""
