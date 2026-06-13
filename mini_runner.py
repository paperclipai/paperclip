#!/usr/bin/env python3
"""Headless mini-swe-agent runner — no TUI, no PTY, no prompt_toolkit needed.

Drop-in replacement for `python -m minisweagent.run.mini` for non-interactive
benchmark use. Accepts the same --config / --task / --yolo / --exit-immediately
flags so mini_swe_wrapper.py needs no argument changes.

Root cause this fixes:
  minisweagent.run.mini always launches the InteractiveAgent TUI (prompt_toolkit
  VT100 input) even with --yolo, aborting with "Input is not a terminal (fd=0)"
  when stdin is not a TTY (Paperclip daemon context). This script uses the Python
  API (DefaultAgent) directly, which has zero TTY requirements.
"""
import argparse, logging, os, sys, traceback
from pathlib import Path

from minisweagent.agents import get_agent
from minisweagent.environments import get_environment
from minisweagent.models import get_model
from minisweagent.config import get_config_from_spec
from minisweagent.utils.serialize import recursive_merge

# ── Token accumulation via LiteLLM success callback ───────────────────────────
_tok = {"input": 0, "output": 0, "peak_input": 0, "calls": 0}

def _litellm_success(kwargs, completion_response, start_time, end_time):
    """Accumulate token usage from every LiteLLM API call."""
    try:
        usage = getattr(completion_response, 'usage', None)
        if usage is None:
            return
        pt = getattr(usage, 'prompt_tokens', 0) or 0
        ct = getattr(usage, 'completion_tokens', 0) or 0
        _tok["input"] += pt
        _tok["output"] += ct
        _tok["calls"] += 1
        if pt > _tok["peak_input"]:
            _tok["peak_input"] = pt
    except Exception:
        pass

try:
    import litellm as _litellm
    _litellm.success_callback = [_litellm_success]
except Exception:
    pass  # litellm unavailable — token tracking will return zeros


def main():
    p = argparse.ArgumentParser(description="Headless mini-swe-agent runner")
    p.add_argument("--config", "-c", action="append", default=[], dest="configs",
                   help="Config file paths (merged left-to-right)")
    p.add_argument("--task", "-t", default="",
                   help="Task description (or set OPENCODE_TASK env var)")
    p.add_argument("--yolo", "-y", action="store_true",
                   help="(ignored — DefaultAgent always runs without confirmation)")
    p.add_argument("--exit-immediately", action="store_true",
                   help="(ignored — DefaultAgent always exits when done)")
    args = p.parse_args()

    task = args.task or os.environ.get("OPENCODE_TASK", "")
    if not task and not sys.stdin.isatty():
        # Paperclip passes the wake payload via stdin (not via OPENCODE_TASK).
        # Read it — stdin is a pipe from the Paperclip daemon, not a TTY.
        task = sys.stdin.read().strip()
        if task:
            print("[mini_runner] Task read from stdin.", file=sys.stderr)
    if not task:
        print("[mini_runner] ERROR: no task provided (--task, OPENCODE_TASK, or stdin)",
              file=sys.stderr)
        sys.exit(1)

    # Load and merge configs (same order as mini.py)
    try:
        configs = [get_config_from_spec(spec) for spec in args.configs]
    except Exception as e:
        print(f"[mini_runner] ERROR loading configs: {e}", file=sys.stderr)
        sys.exit(1)

    merged = {}
    for c in configs:
        merged = recursive_merge(merged, c)

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    # Build components from merged config
    try:
        print("[mini_runner] Building model...", file=sys.stderr, flush=True)
        model = get_model(config=merged.get("model", {}))
        print("[mini_runner] Building environment...", file=sys.stderr, flush=True)
        env   = get_environment(merged.get("environment", {}), default_type="local")
        # Copy agent config so get_agent can safely pop agent_class
        agent_cfg = dict(merged.get("agent", {}))
        print("[mini_runner] Building agent...", file=sys.stderr, flush=True)
        agent = get_agent(model, env, agent_cfg, default_type="default")
    except Exception as e:
        print(f"[mini_runner] ERROR initialising agent: {e}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

    # Run
    exit_code = 0
    try:
        print("[mini_runner] Starting agent.run()...", file=sys.stderr, flush=True)
        agent.run(task)
        print("[mini_runner] Agent completed successfully.", file=sys.stderr, flush=True)
    except SystemExit as e:
        exit_code = e.code if isinstance(e.code, int) else 1
    except Exception as e:
        print(f"[mini_runner] ERROR during agent run: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        exit_code = 1
    finally:
        # Always emit structured token summary — parsed by mini_swe_wrapper.py
        print(
            f"[TOKENS] input={_tok['input']} output={_tok['output']} "
            f"peak_input={_tok['peak_input']} calls={_tok['calls']}",
            file=sys.stderr, flush=True,
        )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
