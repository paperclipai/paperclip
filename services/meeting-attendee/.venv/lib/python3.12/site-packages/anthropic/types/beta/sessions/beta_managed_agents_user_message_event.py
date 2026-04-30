# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Union, Optional
from datetime import datetime
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_text_block import BetaManagedAgentsTextBlock
from .beta_managed_agents_image_block import BetaManagedAgentsImageBlock
from .beta_managed_agents_document_block import BetaManagedAgentsDocumentBlock

__all__ = ["BetaManagedAgentsUserMessageEvent", "Content"]

Content: TypeAlias = Annotated[
    Union[BetaManagedAgentsTextBlock, BetaManagedAgentsImageBlock, BetaManagedAgentsDocumentBlock],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsUserMessageEvent(BaseModel):
    """A user message event in the session conversation."""

    id: str
    """Unique identifier for this event."""

    content: List[Content]
    """Array of content blocks comprising the user message."""

    type: Literal["user.message"]

    processed_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""
