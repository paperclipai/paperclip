# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ...._utils import PropertyInfo
from .beta_message_batch_errored_result import BetaMessageBatchErroredResult
from .beta_message_batch_expired_result import BetaMessageBatchExpiredResult
from .beta_message_batch_canceled_result import BetaMessageBatchCanceledResult
from .beta_message_batch_succeeded_result import BetaMessageBatchSucceededResult

__all__ = ["BetaMessageBatchResult"]

BetaMessageBatchResult: TypeAlias = Annotated[
    Union[
        BetaMessageBatchSucceededResult,
        BetaMessageBatchErroredResult,
        BetaMessageBatchCanceledResult,
        BetaMessageBatchExpiredResult,
    ],
    PropertyInfo(discriminator="type"),
]
