# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ..._utils import PropertyInfo
from .message_batch_errored_result import MessageBatchErroredResult
from .message_batch_expired_result import MessageBatchExpiredResult
from .message_batch_canceled_result import MessageBatchCanceledResult
from .message_batch_succeeded_result import MessageBatchSucceededResult

__all__ = ["MessageBatchResult"]

MessageBatchResult: TypeAlias = Annotated[
    Union[
        MessageBatchSucceededResult, MessageBatchErroredResult, MessageBatchCanceledResult, MessageBatchExpiredResult
    ],
    PropertyInfo(discriminator="type"),
]
