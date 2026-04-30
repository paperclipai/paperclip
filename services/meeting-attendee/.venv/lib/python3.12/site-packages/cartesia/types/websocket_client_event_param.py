# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .generation_request_param import GenerationRequestParam

__all__ = ["WebsocketClientEventParam", "CancelContextRequest"]


class CancelContextRequest(TypedDict, total=False):
    """
    Use this to cancel a context, so that no more messages are generated for that context.
    """

    cancel: Required[Literal[True]]
    """
    Whether to cancel the context, so that no more messages are generated for that
    context.
    """

    context_id: Required[str]
    """The ID of the context to cancel."""


WebsocketClientEventParam: TypeAlias = Union[GenerationRequestParam, CancelContextRequest]
