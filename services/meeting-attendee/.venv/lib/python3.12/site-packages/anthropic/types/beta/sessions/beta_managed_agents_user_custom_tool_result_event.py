# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Union, Optional
from datetime import datetime
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_text_block import BetaManagedAgentsTextBlock
from .beta_managed_agents_image_block import BetaManagedAgentsImageBlock
from .beta_managed_agents_document_block import BetaManagedAgentsDocumentBlock

__all__ = ["BetaManagedAgentsUserCustomToolResultEvent", "Content"]

Content: TypeAlias = Annotated[
    Union[BetaManagedAgentsTextBlock, BetaManagedAgentsImageBlock, BetaManagedAgentsDocumentBlock],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsUserCustomToolResultEvent(BaseModel):
    """Event sent by the client providing the result of a custom tool execution."""

    id: str
    """Unique identifier for this event."""

    custom_tool_use_id: str
    """
    The id of the `agent.custom_tool_use` event this result corresponds to, which
    can be found in the last `session.status_idle`
    [event's](https://platform.claude.com/docs/en/api/beta/sessions/events/list#beta_managed_agents_session_requires_action.event_ids)
    `stop_reason.event_ids` field.
    """

    type: Literal["user.custom_tool_result"]

    content: Optional[List[Content]] = None
    """The result content returned by the tool."""

    is_error: Optional[bool] = None
    """Whether the tool execution resulted in an error."""

    processed_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""
