# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ...._models import BaseModel

__all__ = ["BetaMessageBatchRequestCounts"]


class BetaMessageBatchRequestCounts(BaseModel):
    canceled: int
    """Number of requests in the Message Batch that have been canceled.

    This is zero until processing of the entire Message Batch has ended.
    """

    errored: int
    """Number of requests in the Message Batch that encountered an error.

    This is zero until processing of the entire Message Batch has ended.
    """

    expired: int
    """Number of requests in the Message Batch that have expired.

    This is zero until processing of the entire Message Batch has ended.
    """

    processing: int
    """Number of requests in the Message Batch that are processing."""

    succeeded: int
    """Number of requests in the Message Batch that have completed successfully.

    This is zero until processing of the entire Message Batch has ended.
    """
