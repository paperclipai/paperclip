"""
harness/v0.py — Agent loop harness for the ticket→PR pipeline.

Provides a single entry point:

    result = agent_loop(task=..., tools=..., ...)

The loop calls Claude, dispatches tool calls in parallel, tracks budget, and
writes a transcript to <workspace_dir>/runs/<run_id>/transcript.json after
each turn. Terminates on one of four conditions:

    submit    — the agent called the built-in ``submit`` tool
    max_turns — the configured turn limit was reached
    budget    — cumulative cost exceeded max_cost_usd
    safety    — the safety_check callback returned False for generated content
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Sequence

import anthropic

# ---------------------------------------------------------------------------
# Pricing (USD per million tokens) — update when Anthropic changes rates
# ---------------------------------------------------------------------------

_MODEL_PRICING: dict[str, dict[str, float]] = {
    # input / output per 1M tokens
    "claude-opus-4-7":    {"input": 15.00, "output": 75.00},
    "claude-sonnet-4-6":  {"input": 3.00,  "output": 15.00},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.00},
    # fallback for unknown models
    "_default":           {"input": 3.00,  "output": 15.00},
}

SUBMIT_TOOL_NAME = "submit"

_SUBMIT_TOOL: dict[str, Any] = {
    "name": SUBMIT_TOOL_NAME,
    "description": (
        "Call this tool when the task is complete. "
        "Pass the final result in the `result` field."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "result": {"type": "string", "description": "Final answer or artifact path."},
        },
        "required": ["result"],
    },
}


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class ToolCall:
    name: str
    input: dict[str, Any]
    output: str | None = None
    error: str | None = None
    duration_ms: int = 0


@dataclass
class Turn:
    turn: int
    tokens_in: int
    tokens_out: int
    cost_usd: float
    tool_calls: list[ToolCall] = field(default_factory=list)


@dataclass
class AgentLoopResult:
    run_id: str
    task: str
    model: str
    terminated_by: str          # submit | max_turns | budget | safety
    submit_result: str | None   # value from submit tool, if any
    total_tokens_in: int
    total_tokens_out: int
    total_cost_usd: float
    turns: list[Turn]
    transcript_path: str | None  # absolute path to written transcript


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def agent_loop(
    *,
    task: str,
    tools: Sequence[dict[str, Any]] | None = None,
    model: str = "claude-sonnet-4-6",
    max_turns: int = 30,
    max_cost_usd: float = 0.50,
    output_max_tokens: int = 4096,
    run_id: str | None = None,
    workspace_dir: str | Path | None = None,
    safety_check: Callable[[str], bool] | None = None,
    client: anthropic.Anthropic | None = None,
    tool_executor: Callable[[str, dict[str, Any]], str] | None = None,
) -> AgentLoopResult:
    """
    Run an agent loop.

    Parameters
    ----------
    task:
        The task description passed as the first user message.
    tools:
        List of Anthropic tool-schema dicts the agent may call.
        The ``submit`` tool is always appended automatically.
    model:
        Anthropic model ID.
    max_turns:
        Hard upper bound on the number of assistant turns.
    max_cost_usd:
        Budget cap; terminates with ``budget`` when exceeded.
    output_max_tokens:
        Per-turn max_tokens forwarded to the API.
    run_id:
        Stable identifier for this run; auto-generated if omitted.
    workspace_dir:
        Root directory for transcript files. Defaults to ``./workspace``.
        Transcript written to ``<workspace_dir>/runs/<run_id>/transcript.json``.
    safety_check:
        Optional callback; receives each assistant text block. Return ``False``
        to halt the loop with termination reason ``safety``.
    client:
        Pre-constructed ``anthropic.Anthropic`` client. Useful for testing.
    tool_executor:
        Function ``(tool_name, tool_input) -> str`` that executes a single
        tool call and returns its string output.  When omitted, all tool calls
        (except ``submit``) return a placeholder string.
    """
    run_id = run_id or str(uuid.uuid4())
    workspace_dir = Path(workspace_dir or "workspace")
    user_tools = list(tools or [])
    all_tools = user_tools + [_SUBMIT_TOOL]
    client = client or anthropic.Anthropic()

    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]

    turns: list[Turn] = []
    total_tokens_in = 0
    total_tokens_out = 0
    total_cost_usd = 0.0
    terminated_by: str | None = None
    submit_result: str | None = None

    pricing = _MODEL_PRICING.get(model, _MODEL_PRICING["_default"])

    def _cost(ti: int, to: int) -> float:
        return (ti / 1_000_000) * pricing["input"] + (to / 1_000_000) * pricing["output"]

    def _dispatch_tools(
        tool_uses: list[dict[str, Any]],
    ) -> tuple[list[ToolCall], str | None]:
        """Run tool calls in parallel; return (results, submit_result_or_none)."""
        calls: list[ToolCall] = []
        found_submit: str | None = None

        def _exec_one(tu: dict[str, Any]) -> ToolCall:
            name = tu["name"]
            inp = tu.get("input", {})
            t0 = time.monotonic()
            if name == SUBMIT_TOOL_NAME:
                return ToolCall(
                    name=name,
                    input=inp,
                    output=inp.get("result", ""),
                    duration_ms=0,
                )
            try:
                if tool_executor is not None:
                    out = tool_executor(name, inp)
                else:
                    out = f"[tool:{name}] (no executor configured)"
                duration_ms = int((time.monotonic() - t0) * 1000)
                return ToolCall(name=name, input=inp, output=out, duration_ms=duration_ms)
            except Exception as exc:  # noqa: BLE001
                duration_ms = int((time.monotonic() - t0) * 1000)
                return ToolCall(
                    name=name, input=inp, error=str(exc), duration_ms=duration_ms
                )

        with ThreadPoolExecutor(max_workers=min(len(tool_uses), 8)) as pool:
            futures = {pool.submit(_exec_one, tu): tu for tu in tool_uses}
            for fut in as_completed(futures):
                tc = fut.result()
                calls.append(tc)
                if tc.name == SUBMIT_TOOL_NAME:
                    found_submit = tc.output

        return calls, found_submit

    for turn_num in range(1, max_turns + 1):
        response = client.messages.create(
            model=model,
            max_tokens=output_max_tokens,
            tools=all_tools,  # type: ignore[arg-type]
            messages=messages,
        )

        usage = response.usage
        ti = usage.input_tokens
        to = usage.output_tokens
        cost = _cost(ti, to)

        total_tokens_in += ti
        total_tokens_out += to
        total_cost_usd += cost

        # --- safety check on text blocks ---
        for block in response.content:
            if block.type == "text" and safety_check is not None:
                if not safety_check(block.text):
                    terminated_by = "safety"
                    break
        if terminated_by:
            turns.append(Turn(turn=turn_num, tokens_in=ti, tokens_out=to, cost_usd=cost))
            break

        # --- collect tool uses ---
        tool_uses = [
            {"id": b.id, "name": b.name, "input": b.input}
            for b in response.content
            if b.type == "tool_use"
        ]

        tool_calls: list[ToolCall] = []
        if tool_uses:
            tool_calls, submit_result = _dispatch_tools(tool_uses)

        turns.append(
            Turn(turn=turn_num, tokens_in=ti, tokens_out=to, cost_usd=cost, tool_calls=tool_calls)
        )

        # --- termination checks ---
        if submit_result is not None:
            terminated_by = "submit"
            break

        if total_cost_usd >= max_cost_usd:
            terminated_by = "budget"
            break

        if response.stop_reason == "end_turn" and not tool_uses:
            # No tool calls and natural end — treat like submit with no result
            terminated_by = "submit"
            break

        # --- build next turn messages ---
        messages.append({"role": "assistant", "content": response.content})

        if tool_uses:
            tool_results = []
            for tu in tool_uses:
                # find matching call
                matched = next((tc for tc in tool_calls if tc.name == tu["name"]), None)
                output = (matched.output or matched.error or "") if matched else ""
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu["id"],
                    "content": output,
                })
            messages.append({"role": "user", "content": tool_results})

    else:
        # Exhausted max_turns without breaking
        terminated_by = "max_turns"

    # Ensure terminated_by is always set
    terminated_by = terminated_by or "max_turns"

    result = AgentLoopResult(
        run_id=run_id,
        task=task,
        model=model,
        terminated_by=terminated_by,
        submit_result=submit_result,
        total_tokens_in=total_tokens_in,
        total_tokens_out=total_tokens_out,
        total_cost_usd=total_cost_usd,
        turns=turns,
        transcript_path=None,
    )

    # --- write transcript ---
    try:
        transcript_dir = workspace_dir / "runs" / run_id
        transcript_dir.mkdir(parents=True, exist_ok=True)
        transcript_path = transcript_dir / "transcript.json"
        transcript_data = asdict(result)
        transcript_path.write_text(json.dumps(transcript_data, indent=2))
        result.transcript_path = str(transcript_path.resolve())
    except Exception:  # noqa: BLE001 — non-fatal
        pass

    return result
