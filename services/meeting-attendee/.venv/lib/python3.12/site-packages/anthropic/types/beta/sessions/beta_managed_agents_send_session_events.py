# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Union, Optional
from typing_extensions import Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_user_message_event import BetaManagedAgentsUserMessageEvent
from .beta_managed_agents_user_interrupt_event import BetaManagedAgentsUserInterruptEvent
from .beta_managed_agents_user_tool_confirmation_event import BetaManagedAgentsUserToolConfirmationEvent
from .beta_managed_agents_user_custom_tool_result_event import BetaManagedAgentsUserCustomToolResultEvent

__all__ = ["BetaManagedAgentsSendSessionEvents", "Data"]

Data: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsUserMessageEvent,
        BetaManagedAgentsUserInterruptEvent,
        BetaManagedAgentsUserToolConfirmationEvent,
        BetaManagedAgentsUserCustomToolResultEvent,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsSendSessionEvents(BaseModel):
    """Events that were successfully sent to the session."""

    data: Optional[List[Data]] = None
    """Sent events"""
