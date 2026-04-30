# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsURLDocumentSource"]


class BetaManagedAgentsURLDocumentSource(BaseModel):
    """Document referenced by URL."""

    type: Literal["url"]

    url: str
    """URL of the document to fetch."""
