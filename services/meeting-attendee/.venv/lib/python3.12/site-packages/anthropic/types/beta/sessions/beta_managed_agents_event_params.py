# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .beta_managed_agents_user_message_event_params import BetaManagedAgentsUserMessageEventParams
from .beta_managed_agents_user_interrupt_event_params import BetaManagedAgentsUserInterruptEventParams
from .beta_managed_agents_user_tool_confirmation_event_params import BetaManagedAgentsUserToolConfirmationEventParams
from .beta_managed_agents_user_custom_tool_result_event_params import BetaManagedAgentsUserCustomToolResultEventParams

__all__ = ["BetaManagedAgentsEventParams"]

BetaManagedAgentsEventParams: TypeAlias = Union[
    BetaManagedAgentsUserMessageEventParams,
    BetaManagedAgentsUserInterruptEventParams,
    BetaManagedAgentsUserToolConfirmationEventParams,
    BetaManagedAgentsUserCustomToolResultEventParams,
]
