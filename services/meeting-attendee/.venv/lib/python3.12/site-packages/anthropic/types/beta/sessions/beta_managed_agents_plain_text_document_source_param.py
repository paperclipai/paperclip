# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsPlainTextDocumentSourceParam"]


class BetaManagedAgentsPlainTextDocumentSourceParam(TypedDict, total=False):
    """Plain text document content."""

    data: Required[str]
    """The plain text content."""

    media_type: Required[Literal["text/plain"]]
    """MIME type of the text content. Must be "text/plain"."""

    type: Required[Literal["text"]]
