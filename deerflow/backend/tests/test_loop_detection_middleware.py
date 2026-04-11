"""Tests for LoopDetectionMiddleware and its helper functions.

Covers:
- _normalize_tool_call_args: dict, JSON string, None, and invalid string inputs
- _stable_tool_key: read_file bucketing, write_file hashing, salient field extraction,
  and fallback to full-arg hash
- LoopDetectionMiddleware: unique calls, warn threshold, hard limit, per-thread
  isolation, and custom thresholds
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, HumanMessage

from src.agents.middlewares.loop_detection_middleware import (
    LoopDetectionMiddleware,
    _normalize_tool_call_args,
    _stable_tool_key,
    _WARNING_MSG,
    _HARD_STOP_MSG,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _runtime(thread_id="thread-1"):
    """Build a minimal Runtime-like object with a context dict."""
    rt = MagicMock()
    rt.context = {"thread_id": thread_id}
    return rt


def _ai_message_with_tool_calls(tool_calls):
    """Build an AIMessage that carries the given tool_calls list."""
    msg = AIMessage(content="thinking...", tool_calls=tool_calls)
    return msg


def _tool_call(name, args=None):
    """Shorthand for a single tool call dict."""
    return {"name": name, "args": args or {}, "id": f"call_{name}"}


def _state_with_tool_calls(tool_calls):
    """State dict whose last message is an AIMessage with the given tool_calls."""
    return {"messages": [_ai_message_with_tool_calls(tool_calls)]}


# ---------------------------------------------------------------------------
# _normalize_tool_call_args
# ---------------------------------------------------------------------------


def test_normalize_tool_call_args_dict():
    """Dict input is returned as-is with no fallback key."""
    args = {"path": "/tmp/foo.txt", "start_line": 1}
    result, fallback = _normalize_tool_call_args(args)
    assert result == args
    assert fallback is None


def test_normalize_tool_call_args_json_string():
    """A valid JSON string is parsed into a dict."""
    raw = json.dumps({"query": "hello", "limit": 5})
    result, fallback = _normalize_tool_call_args(raw)
    assert isinstance(result, dict)
    assert result["query"] == "hello"
    assert result["limit"] == 5
    assert fallback is None


def test_normalize_tool_call_args_none():
    """None input returns an empty dict and no fallback key."""
    result, fallback = _normalize_tool_call_args(None)
    assert result == {}
    assert fallback is None


def test_normalize_tool_call_args_invalid_string():
    """An unparseable string returns an empty dict and the raw string as fallback."""
    raw = "not json at all {"
    result, fallback = _normalize_tool_call_args(raw)
    assert result == {}
    assert fallback == raw


# ---------------------------------------------------------------------------
# _stable_tool_key
# ---------------------------------------------------------------------------


def test_stable_tool_key_read_file_buckets_lines():
    """read_file with path and line range returns a bucketed key."""
    key = _stable_tool_key(
        "read_file",
        {"path": "/mnt/user-data/workspace/main.py", "start_line": 10, "end_line": 50},
        None,
    )
    # Bucket size is 200; lines 10-50 both fall in bucket 0
    assert key == "/mnt/user-data/workspace/main.py:0-0"

    # Lines spanning two buckets
    key2 = _stable_tool_key(
        "read_file",
        {"path": "/mnt/user-data/workspace/big.py", "start_line": 190, "end_line": 210},
        None,
    )
    assert key2 == "/mnt/user-data/workspace/big.py:0-1"


def test_stable_tool_key_write_file_hashes_full_args():
    """write_file returns a JSON serialization of the full args dict."""
    args = {"path": "/mnt/user-data/workspace/out.txt", "content": "hello world"}
    key = _stable_tool_key("write_file", args, None)
    # Should be deterministic JSON of the full args
    assert key == json.dumps(args, sort_keys=True, default=str)


def test_stable_tool_key_uses_salient_fields():
    """For a generic tool, salient fields (path, url, query, command) are extracted."""
    args = {"url": "https://example.com", "timeout": 30, "verbose": True}
    key = _stable_tool_key("web_fetch", args, None)
    expected = json.dumps({"url": "https://example.com"}, sort_keys=True, default=str)
    assert key == expected


def test_stable_tool_key_fallback_to_full_hash():
    """When no salient fields are present and no fallback key, hash all args."""
    args = {"foo": "bar", "baz": 42}
    key = _stable_tool_key("some_custom_tool", args, None)
    expected = json.dumps(args, sort_keys=True, default=str)
    assert key == expected


# ---------------------------------------------------------------------------
# LoopDetectionMiddleware
# ---------------------------------------------------------------------------


class TestLoopDetectionMiddleware:
    """Stateful tests for the middleware class."""

    def test_middleware_allows_unique_calls(self):
        """Different tool calls pass through without warnings or stripping."""
        mw = LoopDetectionMiddleware(warn_threshold=3, hard_limit=5)
        rt = _runtime()

        results = []
        for i in range(5):
            state = _state_with_tool_calls([_tool_call("read_file", {"path": f"/file_{i}.py"})])
            result = mw.after_model(state, rt)
            results.append(result)

        # All unique calls should return None (no intervention)
        assert all(r is None for r in results)

    def test_middleware_warns_at_threshold(self):
        """After warn_threshold identical calls, a warning HumanMessage is injected."""
        warn_threshold = 3
        mw = LoopDetectionMiddleware(warn_threshold=warn_threshold, hard_limit=10)
        rt = _runtime()

        tc = [_tool_call("read_file", {"path": "/mnt/user-data/workspace/loop.py", "start_line": 1, "end_line": 50})]

        warning_found = False
        for i in range(warn_threshold):
            state = _state_with_tool_calls(tc)
            result = mw.after_model(state, rt)
            if result is not None:
                warning_found = True
                # The warning should be a HumanMessage with the loop warning text
                msgs = result.get("messages", [])
                assert len(msgs) == 1
                assert isinstance(msgs[0], HumanMessage)
                assert "LOOP DETECTED" in msgs[0].content
                break

        assert warning_found, "Warning was not injected at the warn threshold"

    def test_middleware_strips_at_hard_limit(self):
        """After hard_limit identical calls, tool_calls are removed from the response."""
        hard_limit = 4
        mw = LoopDetectionMiddleware(warn_threshold=2, hard_limit=hard_limit)
        rt = _runtime()

        tc = [_tool_call("bash", {"command": "echo hello"})]

        stripped = False
        for i in range(hard_limit):
            state = _state_with_tool_calls(tc)
            result = mw.after_model(state, rt)
            if result is not None:
                msgs = result.get("messages", [])
                if len(msgs) == 1 and isinstance(msgs[0], AIMessage):
                    # Hard stop: tool_calls stripped, content updated
                    assert msgs[0].tool_calls == []
                    assert "FORCED STOP" in msgs[0].content
                    stripped = True
                    break

        assert stripped, "Tool calls were not stripped at the hard limit"

    def test_middleware_tracks_per_thread(self):
        """Different thread IDs maintain independent counters."""
        mw = LoopDetectionMiddleware(warn_threshold=2, hard_limit=5)

        tc = [_tool_call("read_file", {"path": "/same.py"})]

        # Thread A gets 1 call
        state = _state_with_tool_calls(tc)
        result_a = mw.after_model(state, _runtime("thread-A"))
        assert result_a is None  # first call, no warning

        # Thread B gets 1 call — independent, so also no warning
        result_b = mw.after_model(state, _runtime("thread-B"))
        assert result_b is None

        # Thread A gets a second call — hits warn_threshold=2
        result_a2 = mw.after_model(state, _runtime("thread-A"))
        assert result_a2 is not None
        msgs = result_a2.get("messages", [])
        assert len(msgs) == 1
        assert "LOOP DETECTED" in msgs[0].content

        # Thread B second call also hits its own threshold independently
        result_b2 = mw.after_model(state, _runtime("thread-B"))
        assert result_b2 is not None
        msgs_b = result_b2.get("messages", [])
        assert len(msgs_b) == 1
        assert "LOOP DETECTED" in msgs_b[0].content

    def test_middleware_custom_thresholds(self):
        """Constructor accepts custom warn/hard limits that override defaults."""
        mw = LoopDetectionMiddleware(
            warn_threshold=5,
            hard_limit=8,
            window_size=30,
            tool_freq_warn=100,
            tool_freq_hard_limit=200,
        )

        assert mw.warn_threshold == 5
        assert mw.hard_limit == 8
        assert mw.window_size == 30
        assert mw.tool_freq_warn == 100
        assert mw.tool_freq_hard_limit == 200

        # Verify the custom warn threshold is respected: 4 identical calls
        # should NOT trigger a warning when threshold is 5.
        rt = _runtime()
        tc = [_tool_call("ls", {"path": "/mnt/user-data/workspace"})]

        for _ in range(4):
            state = _state_with_tool_calls(tc)
            result = mw.after_model(state, rt)
            assert result is None, "Warning triggered before custom threshold"

        # The 5th call should trigger the warning
        state = _state_with_tool_calls(tc)
        result = mw.after_model(state, rt)
        assert result is not None
        assert "LOOP DETECTED" in result["messages"][0].content
