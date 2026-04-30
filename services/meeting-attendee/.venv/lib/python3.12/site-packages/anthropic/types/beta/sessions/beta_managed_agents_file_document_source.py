# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsFileDocumentSource"]


class BetaManagedAgentsFileDocumentSource(BaseModel):
    """Document referenced by file ID."""

    file_id: str
    """ID of a previously uploaded file."""

    type: Literal["file"]
