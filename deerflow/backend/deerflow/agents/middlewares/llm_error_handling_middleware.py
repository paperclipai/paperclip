"""Middleware providing LLM error handling with circuit breaker protection.

Prevents rate-limit bans and resource exhaustion by fast-failing after
N consecutive model call failures. Uses a three-state circuit breaker:
closed (normal) -> open (fast-fail) -> half_open (probe one request).
"""

import logging
import threading
import time
from collections.abc import Awaitable, Callable
from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage

logger = logging.getLogger(__name__)

_CIRCUIT_OPEN_MSG = (
    "[CIRCUIT BREAKER] The language model is temporarily unavailable after "
    "{failures} consecutive failures. Requests will resume automatically "
    "in {remaining}s. If this persists, check the model service health."
)


class LLMErrorHandlingMiddleware(AgentMiddleware[AgentState]):
    """LLM error handling with circuit breaker.

    Args:
        failure_threshold: Consecutive failures before opening circuit. Default: 5.
        recovery_timeout_sec: Seconds to fast-fail before probing. Default: 60.
    """

    def __init__(self, failure_threshold: int = 5, recovery_timeout_sec: int = 60):
        super().__init__()
        self.failure_threshold = failure_threshold
        self.recovery_timeout_sec = recovery_timeout_sec
        self._circuit_lock = threading.Lock()
        self._circuit_failure_count = 0
        self._circuit_open_until = 0.0
        self._circuit_state = "closed"  # closed | open | half_open
        self._circuit_probe_in_flight = False

    def _check_circuit(self) -> str | None:
        """Check circuit state. Returns error message if open, None if OK to proceed."""
        with self._circuit_lock:
            now = time.monotonic()
            if self._circuit_state == "closed":
                return None
            if self._circuit_state == "open":
                if now >= self._circuit_open_until:
                    if not self._circuit_probe_in_flight:
                        self._circuit_state = "half_open"
                        self._circuit_probe_in_flight = True
                        logger.info("Circuit breaker half-open — allowing probe request")
                        return None
                remaining = max(1, int(self._circuit_open_until - now))
                return _CIRCUIT_OPEN_MSG.format(failures=self._circuit_failure_count, remaining=remaining)
            # half_open but probe already in flight
            if self._circuit_probe_in_flight:
                return _CIRCUIT_OPEN_MSG.format(failures=self._circuit_failure_count, remaining=self.recovery_timeout_sec)
            return None

    def _record_success(self) -> None:
        with self._circuit_lock:
            if self._circuit_state == "half_open":
                logger.info("Circuit breaker probe succeeded — closing circuit")
            self._circuit_failure_count = 0
            self._circuit_state = "closed"
            self._circuit_open_until = 0.0
            self._circuit_probe_in_flight = False

    def _record_failure(self) -> None:
        with self._circuit_lock:
            self._circuit_failure_count += 1
            self._circuit_probe_in_flight = False
            if self._circuit_failure_count >= self.failure_threshold:
                self._circuit_state = "open"
                self._circuit_open_until = time.monotonic() + self.recovery_timeout_sec
                logger.error(
                    "Circuit breaker opened after %d failures — fast-failing for %ds",
                    self._circuit_failure_count, self.recovery_timeout_sec,
                )

    @override
    def wrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]) -> ModelCallResult:
        circuit_msg = self._check_circuit()
        if circuit_msg:
            return AIMessage(content=circuit_msg)
        try:
            result = handler(request)
            self._record_success()
            return result
        except Exception as exc:
            if type(exc).__name__ == "GraphBubbleUp":
                with self._circuit_lock:
                    self._circuit_probe_in_flight = False
                raise
            self._record_failure()
            raise

    @override
    async def awrap_model_call(self, request: ModelRequest, handler: Callable[[ModelRequest], Awaitable[ModelResponse]]) -> ModelCallResult:
        circuit_msg = self._check_circuit()
        if circuit_msg:
            return AIMessage(content=circuit_msg)
        try:
            result = await handler(request)
            self._record_success()
            return result
        except Exception as exc:
            if type(exc).__name__ == "GraphBubbleUp":
                with self._circuit_lock:
                    self._circuit_probe_in_flight = False
                raise
            self._record_failure()
            raise
