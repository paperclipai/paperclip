# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, List, Optional

from ..._models import BaseModel

__all__ = ["AgentTranscript", "LogEvent", "LogMetric", "TextChunk", "ToolCall"]


class LogEvent(BaseModel):
    """The log event from user code."""

    event: str
    """The event name."""

    metadata: Dict[str, str]
    """Additional metadata associated with the event."""

    timestamp: float
    """The timestamp when the event was received relative to the start of the call."""


class LogMetric(BaseModel):
    """The log metric from user code."""

    name: str
    """The name of the metric."""

    timestamp: float
    """The timestamp when the metric was received relative to the start of the call."""

    value: float
    """The value of the metric."""


class TextChunk(BaseModel):
    start_timestamp: float
    """
    The starting timestamp of the text chunk in seconds relative to the start of the
    call.
    """

    text: str
    """The text content of the chunk."""


class ToolCall(BaseModel):
    id: str
    """The unique identifier for the tool call."""

    arguments: Dict[str, str]
    """The arguments passed to the tool."""

    name: str
    """The name of the tool that was called."""


class AgentTranscript(BaseModel):
    end_timestamp: float
    """The end timestamp in seconds relative to the start of the call."""

    role: str
    """The role of the participant in the conversation.

    Roles are `user`, `assistant`, or `system`. `assistant` is the agent. `system`
    is used to indicate logs during the conversation such as `log_event` or
    `log_metric`.
    """

    start_timestamp: float
    """The start timestamp in seconds relative to the start of the call."""

    end_reason: Optional[str] = None
    """The reason for why the assistant turn ended.

    This could be `call_ended`, `interrupted`, or `tts_completed`.
    """

    log_event: Optional[LogEvent] = None
    """The log event from user code."""

    log_metric: Optional[LogMetric] = None
    """The log metric from user code."""

    text: Optional[str] = None
    """The text content of the transcript.

    This is the text that was spoken by the user or the agent.
    """

    text_chunks: Optional[List[TextChunk]] = None
    """
    The chunks of text at a more granular level in the transcript with timestamps
    relative to the start of the call.
    """

    tool_calls: Optional[List[ToolCall]] = None
    """The tool calls made during the turn."""

    tts_ttfb: Optional[float] = None
    """The time to first byte in seconds from the agent for text-to-speech."""

    vad_buffer_ms: Optional[int] = None
    """The VAD buffer time in milliseconds."""
