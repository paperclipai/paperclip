# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaContainerUploadBlock"]


class BetaContainerUploadBlock(BaseModel):
    """Response model for a file uploaded to the container."""

    file_id: str

    type: Literal["container_upload"]
