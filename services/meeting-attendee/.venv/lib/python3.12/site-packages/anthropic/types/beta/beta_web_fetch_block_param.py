# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_request_document_block_param import BetaRequestDocumentBlockParam

__all__ = ["BetaWebFetchBlockParam"]


class BetaWebFetchBlockParam(TypedDict, total=False):
    content: Required[BetaRequestDocumentBlockParam]

    type: Required[Literal["web_fetch_result"]]

    url: Required[str]
    """Fetched content URL"""

    retrieved_at: Optional[str]
    """ISO 8601 timestamp when the content was retrieved"""
