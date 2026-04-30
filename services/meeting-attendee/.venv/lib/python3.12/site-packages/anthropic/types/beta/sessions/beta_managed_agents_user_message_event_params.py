# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_managed_agents_text_block_param import BetaManagedAgentsTextBlockParam
from .beta_managed_agents_image_block_param import BetaManagedAgentsImageBlockParam
from .beta_managed_agents_document_block_param import BetaManagedAgentsDocumentBlockParam

__all__ = ["BetaManagedAgentsUserMessageEventParams", "Content"]

Content: TypeAlias = Union[
    BetaManagedAgentsTextBlockParam, BetaManagedAgentsImageBlockParam, BetaManagedAgentsDocumentBlockParam
]


class BetaManagedAgentsUserMessageEventParams(TypedDict, total=False):
    """Parameters for sending a user message to the session."""

    content: Required[Iterable[Content]]
    """Array of content blocks for the user message."""

    type: Required[Literal["user.message"]]
