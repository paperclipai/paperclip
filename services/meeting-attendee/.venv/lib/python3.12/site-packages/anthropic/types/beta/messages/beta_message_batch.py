# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime
from typing_extensions import Literal

from ...._models import BaseModel
from .beta_message_batch_request_counts import BetaMessageBatchRequestCounts

__all__ = ["BetaMessageBatch"]


class BetaMessageBatch(BaseModel):
    id: str
    """Unique object identifier.

    The format and length of IDs may change over time.
    """

    archived_at: Optional[datetime] = None
    """
    RFC 3339 datetime string representing the time at which the Message Batch was
    archived and its results became unavailable.
    """

    cancel_initiated_at: Optional[datetime] = None
    """
    RFC 3339 datetime string representing the time at which cancellation was
    initiated for the Message Batch. Specified only if cancellation was initiated.
    """

    created_at: datetime
    """
    RFC 3339 datetime string representing the time at which the Message Batch was
    created.
    """

    ended_at: Optional[datetime] = None
    """
    RFC 3339 datetime string representing the time at which processing for the
    Message Batch ended. Specified only once processing ends.

    Processing ends when every request in a Message Batch has either succeeded,
    errored, canceled, or expired.
    """

    expires_at: datetime
    """
    RFC 3339 datetime string representing the time at which the Message Batch will
    expire and end processing, which is 24 hours after creation.
    """

    processing_status: Literal["in_progress", "canceling", "ended"]
    """Processing status of the Message Batch."""

    request_counts: BetaMessageBatchRequestCounts
    """Tallies requests within the Message Batch, categorized by their status.

    Requests start as `processing` and move to one of the other statuses only once
    processing of the entire batch ends. The sum of all values always matches the
    total number of requests in the batch.
    """

    results_url: Optional[str] = None
    """URL to a `.jsonl` file containing the results of the Message Batch requests.

    Specified only once processing ends.

    Results in the file are not guaranteed to be in the same order as requests. Use
    the `custom_id` field to match results to requests.
    """

    type: Literal["message_batch"]
    """Object type.

    For Message Batches, this is always `"message_batch"`.
    """
