# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsPlainTextDocumentSource"]


class BetaManagedAgentsPlainTextDocumentSource(BaseModel):
    """Plain text document content."""

    data: str
    """The plain text content."""

    media_type: Literal["text/plain"]
    """MIME type of the text content. Must be "text/plain"."""

    type: Literal["text"]
