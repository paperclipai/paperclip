# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..message import Message
from ..._models import BaseModel

__all__ = ["MessageBatchSucceededResult"]


class MessageBatchSucceededResult(BaseModel):
    message: Message

    type: Literal["succeeded"]
