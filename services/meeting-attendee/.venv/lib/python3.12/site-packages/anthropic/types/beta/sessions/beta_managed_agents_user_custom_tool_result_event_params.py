# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_managed_agents_text_block_param import BetaManagedAgentsTextBlockParam
from .beta_managed_agents_image_block_param import BetaManagedAgentsImageBlockParam
from .beta_managed_agents_document_block_param import BetaManagedAgentsDocumentBlockParam

__all__ = ["BetaManagedAgentsUserCustomToolResultEventParams", "Content"]

Content: TypeAlias = Union[
    BetaManagedAgentsTextBlockParam, BetaManagedAgentsImageBlockParam, BetaManagedAgentsDocumentBlockParam
]


class BetaManagedAgentsUserCustomToolResultEventParams(TypedDict, total=False):
    """Parameters for providing the result of a custom tool execution."""

    custom_tool_use_id: Required[str]
    """
    The id of the `agent.custom_tool_use` event this result corresponds to, which
    can be found in the last `session.status_idle`
    [event's](https://platform.claude.com/docs/en/api/beta/sessions/events/list#beta_managed_agents_session_requires_action.event_ids)
    `stop_reason.event_ids` field.
    """

    type: Required[Literal["user.custom_tool_result"]]

    content: Iterable[Content]
    """The result content returned by the tool."""

    is_error: Optional[bool]
    """Whether the tool execution resulted in an error."""
