# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

from .._models import BaseModel
from .generation_request import GenerationRequest

__all__ = ["WebsocketClientEvent", "CancelContextRequest"]


class CancelContextRequest(BaseModel):
    """
    Use this to cancel a context, so that no more messages are generated for that context.
    """

    cancel: Literal[True]
    """
    Whether to cancel the context, so that no more messages are generated for that
    context.
    """

    context_id: str
    """The ID of the context to cancel."""


WebsocketClientEvent: TypeAlias = Union[GenerationRequest, CancelContextRequest]
