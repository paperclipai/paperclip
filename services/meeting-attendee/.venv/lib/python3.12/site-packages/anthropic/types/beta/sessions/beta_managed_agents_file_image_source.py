# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsFileImageSource"]


class BetaManagedAgentsFileImageSource(BaseModel):
    """Image referenced by file ID."""

    file_id: str
    """ID of a previously uploaded file."""

    type: Literal["file"]
