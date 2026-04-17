"""
Tests for harness/v0.py.

All tests mock the Anthropic client so no real API calls are made.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from harness.v0 import agent_loop, AgentLoopResult, SUBMIT_TOOL_NAME


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _usage(input_tokens: int = 100, output_tokens: int = 50) -> SimpleNamespace:
    return SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens)


def _text_block(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=text)


def _tool_use_block(name: str, inp: dict[str, Any], id: str = "tu1") -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=id, name=name, input=inp)


def _response(
    content: list[Any],
    stop_reason: str = "tool_use",
    tokens_in: int = 100,
    tokens_out: int = 50,
) -> SimpleNamespace:
    return SimpleNamespace(
        content=content,
        stop_reason=stop_reason,
        usage=_usage(tokens_in, tokens_out),
    )


def _mock_client(responses: list[SimpleNamespace]) -> MagicMock:
    """Return a mock Anthropic client whose messages.create yields each response in order."""
    client = MagicMock()
    client.messages.create.side_effect = responses
    return client


# ---------------------------------------------------------------------------
# Tests: termination conditions
# ---------------------------------------------------------------------------

class TestTerminatesOnSubmit:
    def test_submit_tool_call_terminates_loop(self, tmp_path):
        """Agent calling the submit tool must cause terminated_by='submit'."""
        submit_response = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "task done"})],
            stop_reason="tool_use",
        )
        client = _mock_client([submit_response])

        result = agent_loop(
            task="Do the thing",
            client=client,
            workspace_dir=tmp_path,
            run_id="run-submit-test",
        )

        assert result.terminated_by == "submit"
        assert result.submit_result == "task done"
        assert len(result.turns) == 1

    def test_end_turn_with_no_tools_terminates_as_submit(self, tmp_path):
        """Natural end_turn with no tool calls terminates as 'submit'."""
        response = _response(
            content=[_text_block("Here is the answer.")],
            stop_reason="end_turn",
        )
        client = _mock_client([response])

        result = agent_loop(
            task="Simple question",
            client=client,
            workspace_dir=tmp_path,
        )

        assert result.terminated_by == "submit"
        assert result.submit_result is None


class TestTerminatesOnMaxTurns:
    def test_loop_stops_at_max_turns(self, tmp_path):
        """Loop must stop after max_turns even if agent keeps calling tools."""
        echo_tool = {
            "name": "echo",
            "description": "Echoes input",
            "input_schema": {"type": "object", "properties": {"msg": {"type": "string"}}, "required": ["msg"]},
        }
        # Every response asks to call echo — never submits
        loop_response = _response(
            content=[_tool_use_block("echo", {"msg": "hello"})],
            stop_reason="tool_use",
        )
        client = _mock_client([loop_response] * 5)

        result = agent_loop(
            task="Loop forever",
            tools=[echo_tool],
            client=client,
            max_turns=3,
            workspace_dir=tmp_path,
            tool_executor=lambda name, inp: inp.get("msg", ""),
        )

        assert result.terminated_by == "max_turns"
        assert len(result.turns) == 3


class TestTerminatesOnBudget:
    def test_loop_stops_when_cost_exceeds_budget(self, tmp_path):
        """Loop must stop when cumulative cost >= max_cost_usd."""
        # Each turn costs: (1_000_000 / 1_000_000) * 3.0 + (1_000_000 / 1_000_000) * 15.0 = $18
        expensive_response = _response(
            content=[_text_block("thinking..."), _tool_use_block("echo", {"msg": "x"})],
            stop_reason="tool_use",
            tokens_in=1_000_000,
            tokens_out=1_000_000,
        )
        client = _mock_client([expensive_response] * 10)

        result = agent_loop(
            task="Burn budget",
            client=client,
            max_turns=10,
            max_cost_usd=0.01,  # much less than one turn's cost
            workspace_dir=tmp_path,
            model="claude-sonnet-4-6",
        )

        assert result.terminated_by == "budget"
        assert result.total_cost_usd >= 0.01

    def test_budget_enforcement_is_per_run(self, tmp_path):
        """Each agent_loop call has an independent budget."""
        cheap_response = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "done"})],
            stop_reason="tool_use",
            tokens_in=10,
            tokens_out=5,
        )

        for _ in range(3):
            result = agent_loop(
                task="Cheap task",
                client=_mock_client([cheap_response]),
                max_cost_usd=0.50,
                workspace_dir=tmp_path,
            )
            assert result.terminated_by == "submit"


class TestTerminatesOnSafety:
    def test_safety_check_halts_loop(self, tmp_path):
        """When safety_check returns False the loop terminates with 'safety'."""
        unsafe_response = _response(
            content=[_text_block("UNSAFE CONTENT HERE")],
            stop_reason="end_turn",
        )
        client = _mock_client([unsafe_response])

        result = agent_loop(
            task="Generate content",
            client=client,
            workspace_dir=tmp_path,
            safety_check=lambda text: "UNSAFE" not in text,
        )

        assert result.terminated_by == "safety"

    def test_safe_content_passes_through(self, tmp_path):
        """Safety check that always passes should not interfere."""
        safe_response = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "safe result"})],
            stop_reason="tool_use",
        )
        client = _mock_client([safe_response])

        result = agent_loop(
            task="Safe task",
            client=client,
            workspace_dir=tmp_path,
            safety_check=lambda _: True,
        )

        assert result.terminated_by == "submit"


# ---------------------------------------------------------------------------
# Tests: transcript format
# ---------------------------------------------------------------------------

class TestTranscriptFormat:
    def test_transcript_contains_required_fields(self, tmp_path):
        """Transcript JSON must include tokens_in, tokens_out, cost_usd, tool_calls per turn."""
        response = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "ok"})],
            stop_reason="tool_use",
            tokens_in=200,
            tokens_out=80,
        )
        client = _mock_client([response])

        result = agent_loop(
            task="Check transcript",
            client=client,
            workspace_dir=tmp_path,
            run_id="transcript-test-run",
        )

        assert result.transcript_path is not None
        data = json.loads(Path(result.transcript_path).read_text())

        assert data["run_id"] == "transcript-test-run"
        assert data["task"] == "Check transcript"
        assert "model" in data
        assert "terminated_by" in data
        assert "total_tokens_in" in data
        assert "total_tokens_out" in data
        assert "total_cost_usd" in data

        assert len(data["turns"]) == 1
        turn = data["turns"][0]
        assert turn["tokens_in"] == 200
        assert turn["tokens_out"] == 80
        assert "cost_usd" in turn
        assert isinstance(turn["tool_calls"], list)

    def test_transcript_written_to_correct_path(self, tmp_path):
        """Transcript must be at <workspace_dir>/runs/<run_id>/transcript.json."""
        response = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "x"})],
            stop_reason="tool_use",
        )
        result = agent_loop(
            task="Path check",
            client=_mock_client([response]),
            workspace_dir=tmp_path,
            run_id="my-run-id",
        )

        expected = tmp_path / "runs" / "my-run-id" / "transcript.json"
        assert expected.exists()
        assert result.transcript_path == str(expected.resolve())


# ---------------------------------------------------------------------------
# Tests: parallel tool dispatch
# ---------------------------------------------------------------------------

class TestParallelToolDispatch:
    def test_multiple_tools_called_in_parallel(self, tmp_path):
        """All tool calls in a single turn must be dispatched and results returned."""
        # Two tool calls in one response, then submit
        first_response = _response(
            content=[
                _tool_use_block("tool_a", {"x": 1}, id="ta"),
                _tool_use_block("tool_b", {"y": 2}, id="tb"),
            ],
            stop_reason="tool_use",
        )
        submit_response = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "done"}, id="ts")],
            stop_reason="tool_use",
        )
        client = _mock_client([first_response, submit_response])

        call_log: list[str] = []
        lock = __import__("threading").Lock()

        def executor(name: str, inp: dict) -> str:
            with lock:
                call_log.append(name)
            return f"{name}-result"

        result = agent_loop(
            task="Multi-tool task",
            client=client,
            workspace_dir=tmp_path,
            tool_executor=executor,
        )

        assert result.terminated_by == "submit"
        assert set(call_log) == {"tool_a", "tool_b"}
        first_turn = result.turns[0]
        tool_names = {tc.name for tc in first_turn.tool_calls}
        assert "tool_a" in tool_names
        assert "tool_b" in tool_names

    def test_tool_error_captured_in_transcript(self, tmp_path):
        """Tool executor errors must be captured in the ToolCall.error field."""
        first_response = _response(
            content=[_tool_use_block("bad_tool", {}, id="bt")],
            stop_reason="tool_use",
        )
        submit_response = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "ok"}, id="ts")],
            stop_reason="tool_use",
        )
        client = _mock_client([first_response, submit_response])

        def failing_executor(name: str, inp: dict) -> str:
            raise RuntimeError("tool exploded")

        result = agent_loop(
            task="Error task",
            client=client,
            workspace_dir=tmp_path,
            tool_executor=failing_executor,
        )

        bad_calls = [tc for tc in result.turns[0].tool_calls if tc.name == "bad_tool"]
        assert len(bad_calls) == 1
        assert bad_calls[0].error == "tool exploded"
        assert bad_calls[0].output is None


# ---------------------------------------------------------------------------
# Tests: cost and token accounting
# ---------------------------------------------------------------------------

class TestCostAccounting:
    def test_total_tokens_accumulate_across_turns(self, tmp_path):
        """total_tokens_in / total_tokens_out must sum across all turns."""
        r1 = _response(
            content=[_tool_use_block("echo", {"msg": "x"}, id="t1")],
            stop_reason="tool_use",
            tokens_in=100,
            tokens_out=50,
        )
        r2 = _response(
            content=[_tool_use_block(SUBMIT_TOOL_NAME, {"result": "ok"}, id="ts")],
            stop_reason="tool_use",
            tokens_in=200,
            tokens_out=80,
        )
        client = _mock_client([r1, r2])

        result = agent_loop(
            task="Accounting",
            client=client,
            workspace_dir=tmp_path,
        )

        assert result.total_tokens_in == 300
        assert result.total_tokens_out == 130
        assert result.total_cost_usd > 0
