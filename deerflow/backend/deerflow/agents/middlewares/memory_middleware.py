"""Middleware for memory mechanism."""

import re
from typing import Any, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.memory.queue import get_memory_queue
from deerflow.config.memory_config import get_memory_config


class MemoryMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    pass


def _filter_messages_for_memory(messages: list[Any]) -> list[Any]:
    """Filter messages to keep only user inputs and final assistant responses.

    This filters out:
    - Tool messages (intermediate tool call results)
    - AI messages with tool_calls (intermediate steps, not final responses)
    - The <uploaded_files> block injected by UploadsMiddleware into human messages
      (file paths are session-scoped and must not persist in long-term memory).
      The user's actual question is preserved; only turns whose content is entirely
      the upload block (nothing remains after stripping) are dropped along with
      their paired assistant response.

    Only keeps:
    - Human messages (with the ephemeral upload block removed)
    - AI messages without tool_calls (final assistant responses), unless the
      paired human turn was upload-only and had no real user text.

    Args:
        messages: List of all conversation messages.

    Returns:
        Filtered list containing only user inputs and final assistant responses.
    """
    _UPLOAD_BLOCK_RE = re.compile(r"<uploaded_files>[\s\S]*?</uploaded_files>\n*", re.IGNORECASE)

    filtered = []
    skip_next_ai = False
    for msg in messages:
        msg_type = getattr(msg, "type", None)

        if msg_type == "human":
            content = getattr(msg, "content", "")
            if isinstance(content, list):
                content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
            content_str = str(content)
            if "<uploaded_files>" in content_str:
                # Strip the ephemeral upload block; keep the user's real question.
                stripped = _UPLOAD_BLOCK_RE.sub("", content_str).strip()
                if not stripped:
                    # Nothing left — the entire turn was upload bookkeeping;
                    # skip it and the paired assistant response.
                    skip_next_ai = True
                    continue
                # Rebuild the message with cleaned content so the user's question
                # is still available for memory summarisation.
                from copy import copy

                clean_msg = copy(msg)
                clean_msg.content = stripped
                filtered.append(clean_msg)
                skip_next_ai = False
            else:
                filtered.append(msg)
                skip_next_ai = False
        elif msg_type == "ai":
            tool_calls = getattr(msg, "tool_calls", None)
            if not tool_calls:
                if skip_next_ai:
                    skip_next_ai = False
                    continue
                filtered.append(msg)
        # Skip tool messages and AI messages with tool_calls

    return filtered


# Correction patterns — user is correcting or contradicting prior information
_CORRECTION_PATTERNS = [
    re.compile(r"\bactually\b[,.]?\s", re.IGNORECASE),
    re.compile(r"\bno[,.]?\s+I\s+meant\b", re.IGNORECASE),
    re.compile(r"\bthat'?s\s+(wrong|incorrect|not\s+right)\b", re.IGNORECASE),
    re.compile(r"\bnot\s+\w+[,.]?\s+(but|rather)\b", re.IGNORECASE),
    re.compile(r"\bI\s+(was\s+wrong|made\s+a\s+mistake)\b", re.IGNORECASE),
    re.compile(r"\bcorrection\b", re.IGNORECASE),
    re.compile(r"\blet\s+me\s+correct\b", re.IGNORECASE),
    re.compile(r"\bI\s+should\s+have\s+said\b", re.IGNORECASE),
    re.compile(r"\bwhat\s+I\s+meant\s+(was|is)\b", re.IGNORECASE),
    re.compile(r"\bsorry[,.]?\s+I\s+meant\b", re.IGNORECASE),
    re.compile(r"\u4e0d\u5bf9", re.IGNORECASE),  # 不对 (Chinese: "not right")
    re.compile(r"\u6211\u8bf4\u9519\u4e86", re.IGNORECASE),  # 我说错了 (Chinese: "I misspoke")
]

# Number of recent human messages to check for correction/reinforcement
_DETECTION_WINDOW = 3


def _extract_message_text(msg: Any) -> str:
    """Extract text content from a message object."""
    content = getattr(msg, "content", "")
    if isinstance(content, list):
        parts = [p.get("text", "") for p in content if isinstance(p, dict) and "text" in p]
        return " ".join(parts)
    return str(content)


def detect_correction(messages: list[Any]) -> bool:
    """Detect if recent human messages contain correction patterns.

    Only checks the last _DETECTION_WINDOW human messages to avoid false
    positives from old conversation history.
    """
    human_texts = [
        _extract_message_text(m)
        for m in messages
        if getattr(m, "type", None) == "human"
    ]
    recent = human_texts[-_DETECTION_WINDOW:]
    for text in recent:
        for pattern in _CORRECTION_PATTERNS:
            if pattern.search(text):
                return True
    return False


_REINFORCEMENT_PATTERNS = [
    re.compile(r"\bas\s+I\s+mentioned\b", re.IGNORECASE),
    re.compile(r"\blike\s+I\s+said\b", re.IGNORECASE),
    re.compile(r"\bremember\s+that\b", re.IGNORECASE),
    re.compile(r"\bI\s+always\b", re.IGNORECASE),
    re.compile(r"\bas\s+I\s+told\s+you\b", re.IGNORECASE),
    re.compile(r"\bI'?ve\s+(?:always|already)\s+said\b", re.IGNORECASE),
    re.compile(r"\bI\s+keep\s+(?:saying|telling)\b", re.IGNORECASE),
    re.compile(r"\bagain[,.]?\s", re.IGNORECASE),
    re.compile(r"\bonce\s+more\b", re.IGNORECASE),
    re.compile(r"\bI\s+(?:still|continue\s+to)\b", re.IGNORECASE),
    re.compile(r"\bmy\s+preference\s+(?:is|remains)\b", re.IGNORECASE),
    re.compile(r"\u6211\u8bf4\u8fc7", re.IGNORECASE),  # 我说过 (Chinese: "I've said")
    re.compile(r"\u6211\u4e00\u76f4", re.IGNORECASE),  # 我一直 (Chinese: "I always")
]


def detect_reinforcement(messages: list[Any]) -> bool:
    """Detect if recent human messages contain reinforcement patterns.

    Only checks the last _DETECTION_WINDOW human messages.
    """
    human_texts = [
        _extract_message_text(m)
        for m in messages
        if getattr(m, "type", None) == "human"
    ]
    recent = human_texts[-_DETECTION_WINDOW:]
    for text in recent:
        for pattern in _REINFORCEMENT_PATTERNS:
            if pattern.search(text):
                return True
    return False


class MemoryMiddleware(AgentMiddleware[MemoryMiddlewareState]):
    """Middleware that queues conversation for memory update after agent execution.

    This middleware:
    1. After each agent execution, queues the conversation for memory update
    2. Only includes user inputs and final assistant responses (ignores tool calls)
    3. The queue uses debouncing to batch multiple updates together
    4. Memory is updated asynchronously via LLM summarization
    """

    state_schema = MemoryMiddlewareState

    def __init__(self, agent_name: str | None = None):
        """Initialize the MemoryMiddleware.

        Args:
            agent_name: If provided, memory is stored per-agent. If None, uses global memory.
        """
        super().__init__()
        self._agent_name = agent_name

    @override
    def after_agent(self, state: MemoryMiddlewareState, runtime: Runtime) -> dict | None:
        """Queue conversation for memory update after agent completes.

        Args:
            state: The current agent state.
            runtime: The runtime context.

        Returns:
            None (no state changes needed from this middleware).
        """
        config = get_memory_config()
        if not config.enabled:
            return None

        # Get thread ID from runtime context
        thread_id = runtime.context.get("thread_id")
        if not thread_id:
            print("MemoryMiddleware: No thread_id in context, skipping memory update")
            return None

        # Get messages from state
        messages = state.get("messages", [])
        if not messages:
            print("MemoryMiddleware: No messages in state, skipping memory update")
            return None

        # Filter to only keep user inputs and final assistant responses
        filtered_messages = _filter_messages_for_memory(messages)

        # Only queue if there's meaningful conversation
        # At minimum need one user message and one assistant response
        user_messages = [m for m in filtered_messages if getattr(m, "type", None) == "human"]
        assistant_messages = [m for m in filtered_messages if getattr(m, "type", None) == "ai"]

        if not user_messages or not assistant_messages:
            return None

        # Extract Paperclip context for memory sync
        paperclip_ctx = None
        api_url = runtime.context.get("paperclip_api_url")
        company_id = runtime.context.get("paperclip_company_id")
        auth_token = runtime.context.get("paperclip_auth_token")
        if api_url and company_id and auth_token:
            paperclip_ctx = {
                "api_url": api_url,
                "company_id": company_id,
                "auth_token": auth_token,
            }

        # Detect correction and reinforcement in recent messages
        correction_detected = detect_correction(filtered_messages)
        reinforcement_detected = detect_reinforcement(filtered_messages)
        # Mutual exclusion: correction takes priority
        if correction_detected:
            reinforcement_detected = False

        # Queue with correction and reinforcement flags
        queue = get_memory_queue()
        queue.add(
            thread_id=thread_id,
            messages=filtered_messages,
            agent_name=self._agent_name,
            paperclip_ctx=paperclip_ctx,
            correction_detected=correction_detected,
            reinforcement_detected=reinforcement_detected,
        )

        return None
