# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_document_block import BetaDocumentBlock

__all__ = ["BetaWebFetchBlock"]


class BetaWebFetchBlock(BaseModel):
    content: BetaDocumentBlock

    retrieved_at: Optional[str] = None
    """ISO 8601 timestamp when the content was retrieved"""

    type: Literal["web_fetch_result"]

    url: str
    """Fetched content URL"""
