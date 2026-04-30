# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsBase64DocumentSourceParam"]


class BetaManagedAgentsBase64DocumentSourceParam(TypedDict, total=False):
    """Base64-encoded document data."""

    data: Required[str]
    """Base64-encoded document data."""

    media_type: Required[str]
    """MIME type of the document (e.g., "application/pdf")."""

    type: Required[Literal["base64"]]
