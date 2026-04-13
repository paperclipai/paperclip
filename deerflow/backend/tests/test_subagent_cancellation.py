"""Tests for subagent cooperative cancellation.

Uses importlib to load the real executor module while keeping the conftest
mock in sys.modules for other tests.  We need to temporarily mock out the
heavy transitive imports (thread_state, langchain, etc.) that cause the
circular-import chain that conftest exists to prevent.
"""

import importlib
import importlib.util
import sys
import threading
import types
from unittest.mock import MagicMock


def _load_executor_directly():
    """Load executor.py as a standalone module, stubbing heavy deps."""
    # Build minimal stubs for every import that executor.py needs
    stubs = {}

    # langchain.agents
    la = types.ModuleType("langchain.agents")
    la.create_agent = MagicMock()
    stubs["langchain"] = types.ModuleType("langchain")
    stubs["langchain.agents"] = la

    # langchain.tools
    lt = types.ModuleType("langchain.tools")
    lt.BaseTool = MagicMock
    stubs["langchain.tools"] = lt

    # langchain_core.*
    lc = types.ModuleType("langchain_core")
    lcm = types.ModuleType("langchain_core.messages")
    lcm.AIMessage = MagicMock
    lcm.HumanMessage = MagicMock
    lcr = types.ModuleType("langchain_core.runnables")
    lcr.RunnableConfig = dict
    stubs["langchain_core"] = lc
    stubs["langchain_core.messages"] = lcm
    stubs["langchain_core.runnables"] = lcr

    # deerflow.agents.thread_state
    ts = types.ModuleType("deerflow.agents.thread_state")
    ts.SandboxState = MagicMock
    ts.ThreadDataState = MagicMock
    ts.ThreadState = MagicMock
    stubs["deerflow.agents"] = types.ModuleType("deerflow.agents")
    stubs["deerflow.agents.thread_state"] = ts

    # deerflow.models
    dm = types.ModuleType("deerflow.models")
    dm.create_chat_model = MagicMock()
    stubs["deerflow.models"] = dm

    # deerflow.subagents.config
    dsc = types.ModuleType("deerflow.subagents.config")
    dsc.SubagentConfig = MagicMock
    stubs["deerflow.subagents"] = types.ModuleType("deerflow.subagents")
    stubs["deerflow.subagents.config"] = dsc

    # Inject stubs, remembering originals
    saved = {}
    for key, mod in stubs.items():
        saved[key] = sys.modules.get(key)
        sys.modules[key] = mod

    # Also remove the conftest mock for the executor itself
    executor_key = "deerflow.subagents.executor"
    saved[executor_key] = sys.modules.pop(executor_key, None)

    try:
        spec = importlib.util.spec_from_file_location(
            executor_key,
            "/home/prime/Repos/paperclip/deerflow/backend/deerflow/subagents/executor.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        # Restore everything
        for key, orig in saved.items():
            if orig is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = orig


_real = _load_executor_directly()
SubagentStatus = _real.SubagentStatus
SubagentResult = _real.SubagentResult
_background_tasks = _real._background_tasks
request_cancel_background_task = _real.request_cancel_background_task


class TestSubagentCancellation:
    def test_cancelled_status_exists(self):
        assert hasattr(SubagentStatus, "CANCELLED")
        assert SubagentStatus.CANCELLED.value == "cancelled"

    def test_result_has_cancel_event(self):
        result = SubagentResult(
            task_id="test",
            trace_id="trace",
            status=SubagentStatus.PENDING,
        )
        assert hasattr(result, "cancel_event")
        assert isinstance(result.cancel_event, threading.Event)

    def test_cancel_event_not_set_by_default(self):
        result = SubagentResult(
            task_id="test",
            trace_id="trace",
            status=SubagentStatus.PENDING,
        )
        assert not result.cancel_event.is_set()

    def test_request_cancel_sets_event(self):
        result = SubagentResult(
            task_id="test-cancel",
            trace_id="trace",
            status=SubagentStatus.RUNNING,
        )
        _background_tasks["test-cancel"] = result

        request_cancel_background_task("test-cancel")
        assert result.cancel_event.is_set()

        # Cleanup
        del _background_tasks["test-cancel"]

    def test_request_cancel_nonexistent_no_error(self):
        request_cancel_background_task("nonexistent-task")
