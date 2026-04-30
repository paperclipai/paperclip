# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from ..._models import BaseModel
from .message_batch_result import MessageBatchResult

__all__ = ["MessageBatchIndividualResponse"]


class MessageBatchIndividualResponse(BaseModel):
    """
    This is a single line in the response `.jsonl` file and does not represent the response as a whole.
    """

    custom_id: str
    """Developer-provided ID created for each request in a Message Batch.

    Useful for matching results to requests, as results may be given out of request
    order.

    Must be unique for each request within the Message Batch.
    """

    result: MessageBatchResult
    """Processing result for this request.

    Contains a Message output if processing was successful, an error response if
    processing failed, or the reason why processing was not attempted, such as
    cancellation or expiration.
    """
