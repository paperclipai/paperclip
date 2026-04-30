# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ...._utils import PropertyInfo
from .beta_managed_agents_user_message_event import BetaManagedAgentsUserMessageEvent
from .beta_managed_agents_agent_message_event import BetaManagedAgentsAgentMessageEvent
from .beta_managed_agents_session_error_event import BetaManagedAgentsSessionErrorEvent
from .beta_managed_agents_agent_thinking_event import BetaManagedAgentsAgentThinkingEvent
from .beta_managed_agents_agent_tool_use_event import BetaManagedAgentsAgentToolUseEvent
from .beta_managed_agents_user_interrupt_event import BetaManagedAgentsUserInterruptEvent
from .beta_managed_agents_session_deleted_event import BetaManagedAgentsSessionDeletedEvent
from .beta_managed_agents_agent_tool_result_event import BetaManagedAgentsAgentToolResultEvent
from .beta_managed_agents_agent_mcp_tool_use_event import BetaManagedAgentsAgentMCPToolUseEvent
from .beta_managed_agents_session_status_idle_event import BetaManagedAgentsSessionStatusIdleEvent
from .beta_managed_agents_agent_custom_tool_use_event import BetaManagedAgentsAgentCustomToolUseEvent
from .beta_managed_agents_agent_mcp_tool_result_event import BetaManagedAgentsAgentMCPToolResultEvent
from .beta_managed_agents_session_status_running_event import BetaManagedAgentsSessionStatusRunningEvent
from .beta_managed_agents_span_model_request_end_event import BetaManagedAgentsSpanModelRequestEndEvent
from .beta_managed_agents_user_tool_confirmation_event import BetaManagedAgentsUserToolConfirmationEvent
from .beta_managed_agents_user_custom_tool_result_event import BetaManagedAgentsUserCustomToolResultEvent
from .beta_managed_agents_span_model_request_start_event import BetaManagedAgentsSpanModelRequestStartEvent
from .beta_managed_agents_session_status_terminated_event import BetaManagedAgentsSessionStatusTerminatedEvent
from .beta_managed_agents_session_status_rescheduled_event import BetaManagedAgentsSessionStatusRescheduledEvent
from .beta_managed_agents_agent_thread_context_compacted_event import BetaManagedAgentsAgentThreadContextCompactedEvent

__all__ = ["BetaManagedAgentsStreamSessionEvents"]

BetaManagedAgentsStreamSessionEvents: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsUserMessageEvent,
        BetaManagedAgentsUserInterruptEvent,
        BetaManagedAgentsUserToolConfirmationEvent,
        BetaManagedAgentsUserCustomToolResultEvent,
        BetaManagedAgentsAgentCustomToolUseEvent,
        BetaManagedAgentsAgentMessageEvent,
        BetaManagedAgentsAgentThinkingEvent,
        BetaManagedAgentsAgentMCPToolUseEvent,
        BetaManagedAgentsAgentMCPToolResultEvent,
        BetaManagedAgentsAgentToolUseEvent,
        BetaManagedAgentsAgentToolResultEvent,
        BetaManagedAgentsAgentThreadContextCompactedEvent,
        BetaManagedAgentsSessionErrorEvent,
        BetaManagedAgentsSessionStatusRescheduledEvent,
        BetaManagedAgentsSessionStatusRunningEvent,
        BetaManagedAgentsSessionStatusIdleEvent,
        BetaManagedAgentsSessionStatusTerminatedEvent,
        BetaManagedAgentsSpanModelRequestStartEvent,
        BetaManagedAgentsSpanModelRequestEndEvent,
        BetaManagedAgentsSessionDeletedEvent,
    ],
    PropertyInfo(discriminator="type"),
]
