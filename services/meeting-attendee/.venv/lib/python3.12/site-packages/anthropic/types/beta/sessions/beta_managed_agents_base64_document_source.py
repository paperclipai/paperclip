# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsBase64DocumentSource"]


class BetaManagedAgentsBase64DocumentSource(BaseModel):
    """Base64-encoded document data."""

    data: str
    """Base64-encoded document data."""

    media_type: str
    """MIME type of the document (e.g., "application/pdf")."""

    type: Literal["base64"]
