# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaDeletedMessageBatch"]


class BetaDeletedMessageBatch(BaseModel):
    id: str
    """ID of the Message Batch."""

    type: Literal["message_batch_deleted"]
    """Deleted object type.

    For Message Batches, this is always `"message_batch_deleted"`.
    """
