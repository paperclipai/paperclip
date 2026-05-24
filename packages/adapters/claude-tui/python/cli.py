#!/usr/bin/env python3
"""JSON-lines CLI shim around ClaudeTuiDriver.

Spawned by Node (or any caller). Reads commands on stdin, writes events on
stdout. One JSON object per line, both directions. Stable wire format.

Commands (stdin):
    {"type": "turn", "prompt": "..."}
    {"type": "shutdown"}

Events (stdout):
    {"type": "ready", "session_id": "...", "model": "...", "plan": "..."}
    {"type": "turn_start", "prompt": "..."}
    {"type": "modal", "kind": "read|bash|...", "action": "approve|deny|...",
        "key_sent": "1"}
    {"type": "chunk", "text": "..."}
    {"type": "turn_end", "response_text": "...", "elapsed_sec": 6.2,
        "usage_pct": 9, "exit_reason": "complete|timeout|escalation"}
    {"type": "log", "level": "info|warn|error", "msg": "..."}
    {"type": "exit", "reason": "shutdown|child_dead|fatal", "detail": "..."}

Cancellation contract: own process group (setpgrp), SIGTERM/SIGINT trigger
graceful shutdown, driver.close() reaps the `claude` PTY child.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Optional

# Local imports — siblings.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from driver import ClaudeTuiDriver, TurnResult  # noqa: E402
from status_parser import parse_welcome  # noqa: E402


# ---------------------------------------------------------------------------
# Stdout writer with a single lock so threads don't interleave lines
# ---------------------------------------------------------------------------

_stdout_lock = threading.Lock()
_log_stderr = False


def emit(event: dict[str, Any]) -> None:
    """Write a single JSON object + newline to stdout, flush immediately."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with _stdout_lock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            # Stdout closed under us; nothing useful to do.
            pass


def emit_log(level: str, msg: str) -> None:
    emit({"type": "log", "level": level, "msg": msg})
    if _log_stderr:
        try:
            sys.stderr.write(f"[cli {level}] {msg}\n")
            sys.stderr.flush()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Shutdown coordination
# ---------------------------------------------------------------------------

# Set by the signal handler / stdin EOF. Workers check it between operations.
_shutdown_requested = threading.Event()
_shutdown_reason = "shutdown"
_shutdown_detail = ""

# Set once the worker has fully torn down so the main thread can exit.
_shutdown_complete = threading.Event()


def request_shutdown(reason: str = "shutdown", detail: str = "") -> None:
    global _shutdown_reason, _shutdown_detail
    if _shutdown_requested.is_set():
        return
    _shutdown_reason = reason
    _shutdown_detail = detail
    _shutdown_requested.set()


# ---------------------------------------------------------------------------
# Stdin reader thread — pushes parsed commands onto a queue
# ---------------------------------------------------------------------------


class StdinReader(threading.Thread):
    def __init__(self, command_q: "queue.Queue[dict]"):
        super().__init__(name="stdin-reader", daemon=True)
        self._q = command_q

    def run(self) -> None:
        try:
            for raw in sys.stdin:
                if _shutdown_requested.is_set():
                    return
                line = raw.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as exc:
                    emit_log("warn", f"invalid stdin JSON, ignoring: {exc!s}")
                    continue
                if not isinstance(obj, dict) or "type" not in obj:
                    emit_log("warn", "stdin object missing 'type', ignoring")
                    continue
                self._q.put(obj)
        except Exception as exc:
            emit_log("error", f"stdin reader crashed: {exc!r}")
        finally:
            # EOF on stdin == graceful shutdown.
            request_shutdown("shutdown", "stdin closed")
            # Wake the worker if it's blocked on the queue.
            self._q.put({"type": "__eof__"})


# ---------------------------------------------------------------------------
# Worker: owns the driver, processes commands serially
# ---------------------------------------------------------------------------


def _policy_for_driver(cli_policy: str) -> str:
    """Translate the CLI's policy vocabulary into the driver's.

    The driver/modal_handler accepts:
        auto_approve, auto_approve_safe_only, auto_deny, escalate
    The CLI exposes:
        auto_approve, auto_deny, escalate, observe

    `observe` is a watch-only mode — we map it to `escalate` so any modal
    halts the turn with exit_reason=escalation, and the caller can see what
    would have been asked.
    """
    if cli_policy == "observe":
        return "escalate"
    return cli_policy


def _emit_turn_result(prompt: str, r: TurnResult) -> None:
    # Emit modal events that the driver captured during the turn. The driver
    # records them in r.modals_handled in chronological order.
    for m in r.modals_handled:
        emit({
            "type": "modal",
            "kind": m.get("kind", "unknown"),
            "action": m.get("action", "unknown"),
            "key_sent": m.get("key_sent"),
        })

    # One chunk for the full response (future: real streaming).
    if r.response_text:
        emit({"type": "chunk", "text": r.response_text})

    emit({
        "type": "turn_end",
        "response_text": r.response_text,
        "elapsed_sec": round(r.elapsed_sec, 3),
        "usage_pct": r.usage_pct_after,
        "exit_reason": r.exit_reason,
    })


# The active driver, exposed so the main/signal thread can force-close it
# to break the worker out of a blocking send_turn() on SIGTERM.
_active_driver: Optional[ClaudeTuiDriver] = None
_active_driver_lock = threading.Lock()


def worker_main(
    *,
    cwd: str,
    policy: str,
    poll_usage: bool,
    byte_archive: Optional[str],
    command_q: "queue.Queue[dict]",
) -> int:
    """Main worker loop. Returns the desired process exit code."""
    global _active_driver
    driver_policy = _policy_for_driver(policy)
    exit_code = 0

    drv = ClaudeTuiDriver(
        cwd=cwd,
        policy=driver_policy,
        poll_usage=poll_usage,
        byte_archive_path=byte_archive,
    )
    with _active_driver_lock:
        _active_driver = drv

    try:
        try:
            drv.start()
        except Exception as exc:
            emit_log("error", f"driver.start() failed: {exc!r}")
            request_shutdown("fatal", f"start failed: {exc!r}")
            return 1

        # Best-effort: parse welcome banner for model/plan and grab session id.
        model: Optional[str] = None
        plan: Optional[str] = None
        try:
            snap = drv._session.snapshot()  # noqa: SLF001 — intentional
            welcome = parse_welcome(snap.visible_text or snap.history_text)
            model = welcome.model
            plan = welcome.plan
        except Exception as exc:
            emit_log("warn", f"welcome parse failed: {exc!r}")

        session_id: Optional[str] = None
        try:
            session_id = drv.get_session_id()
        except Exception as exc:
            emit_log("warn", f"get_session_id failed: {exc!r}")

        emit({
            "type": "ready",
            "session_id": session_id,
            "model": model,
            "plan": plan,
        })

        # Command loop.
        while not _shutdown_requested.is_set():
            try:
                cmd = command_q.get(timeout=0.25)
            except queue.Empty:
                continue

            ctype = cmd.get("type")
            if ctype == "__eof__":
                # Stdin reader signalled us; loop will exit via the
                # _shutdown_requested check.
                continue
            if ctype == "shutdown":
                request_shutdown("shutdown", "client requested")
                break
            if ctype == "turn":
                prompt = cmd.get("prompt")
                if not isinstance(prompt, str) or not prompt:
                    emit_log("warn", "turn command missing 'prompt', ignoring")
                    continue
                emit({"type": "turn_start", "prompt": prompt})
                try:
                    result = drv.send_turn(prompt)
                except Exception as exc:
                    emit_log("error", f"send_turn raised: {exc!r}")
                    emit_log("error", traceback.format_exc())
                    request_shutdown("fatal", f"send_turn: {exc!r}")
                    exit_code = 1
                    break
                _emit_turn_result(prompt, result)
                if result.exit_reason == "child_dead":
                    request_shutdown("child_dead", "claude TUI exited mid-turn")
                    break
                continue

            emit_log("warn", f"unknown command type {ctype!r}, ignoring")

    finally:
        # Always tear down the PTY child.
        try:
            drv.close()
        except Exception as exc:
            emit_log("error", f"driver.close() failed: {exc!r}")
        with _active_driver_lock:
            _active_driver = None  # type: ignore[assignment]

    return exit_code


# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------


def _install_signal_handlers() -> None:
    def handler(signum, _frame):
        name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
        emit_log("info", f"received {name}, shutting down")
        request_shutdown("shutdown", f"signal {name}")

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)
    # SIGHUP if available (POSIX); treat like SIGTERM.
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, handler)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="claude-tui-cli",
        description="JSON-lines bridge to the Claude Code TUI driver.",
    )
    p.add_argument("--cwd", required=True, help="working directory for the spawned claude TUI")
    p.add_argument("--config-dir", default=None,
                   help="set CLAUDE_CONFIG_DIR for the child (per-agent isolation)")
    p.add_argument("--policy",
                   choices=["auto_approve", "auto_deny", "escalate", "observe"],
                   default="auto_approve")
    p.add_argument("--no-poll-usage", action="store_true",
                   help="skip /usage polling between turns")
    p.add_argument("--byte-archive", default=None,
                   help="path to write the raw PTY byte stream for offline replay")
    p.add_argument("--log-stderr", action="store_true",
                   help="also mirror log events to stderr for human debugging")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    global _log_stderr

    args = parse_args(argv)
    _log_stderr = bool(args.log_stderr)

    # Own our process group so SIGTERM only hits us and our descendants.
    try:
        os.setpgrp()
    except (OSError, PermissionError):
        # Already a leader, or sandbox forbids it. Not fatal.
        pass

    # CLAUDE_CONFIG_DIR isolation: set in our env BEFORE the driver spawns
    # the child. capture.py strips it from inherited env, so we set it on
    # the worker process; capture.py will then pick it up from our env...
    # Actually capture.py STRIPS CLAUDE_CONFIG_DIR. So we route it through
    # env_overrides instead — but that path isn't wired through the driver.
    # Simpler: monkey-patch by mutating capture's strip set is too sneaky.
    # Cleanest: extend ClaudeTuiSession via env_overrides in a thin wrapper.
    #
    # For now, set the env var on ourselves; capture.py strips it from the
    # inherited copy but we re-add it via env_overrides below.
    config_dir = args.config_dir
    if config_dir:
        os.environ["CLAUDE_CONFIG_DIR"] = config_dir

    _install_signal_handlers()

    # Validate cwd early so we can give a clean error event.
    if not os.path.isdir(args.cwd):
        try:
            os.makedirs(args.cwd, exist_ok=True)
        except Exception as exc:
            emit_log("error", f"cwd {args.cwd!r} does not exist and could not be created: {exc!r}")
            emit({"type": "exit", "reason": "fatal", "detail": f"bad cwd: {exc!r}"})
            return 2

    command_q: "queue.Queue[dict]" = queue.Queue()
    reader = StdinReader(command_q)
    reader.start()

    # Patch the capture module's env strip set so CLAUDE_CONFIG_DIR survives,
    # but only if the user actually asked for one. This is the least invasive
    # way to wire it through without touching driver.py / capture.py.
    if config_dir:
        try:
            import capture as _capture
            _capture._STRIP_EXACT.discard("CLAUDE_CONFIG_DIR")
        except Exception as exc:
            emit_log("warn", f"could not propagate CLAUDE_CONFIG_DIR: {exc!r}")

    exit_code = 1
    worker_exc: Optional[BaseException] = None

    def _worker_thread_entry() -> None:
        nonlocal exit_code, worker_exc
        try:
            exit_code = worker_main(
                cwd=args.cwd,
                policy=args.policy,
                poll_usage=not args.no_poll_usage,
                byte_archive=args.byte_archive,
                command_q=command_q,
            )
        except BaseException as exc:  # noqa: BLE001
            worker_exc = exc
            emit_log("error", f"worker crashed: {exc!r}")
            emit_log("error", traceback.format_exc())
            request_shutdown("fatal", f"worker: {exc!r}")
        finally:
            _shutdown_complete.set()

    # Daemon so a final hard timeout can drop it; under normal teardown the
    # main loop joins it explicitly via _shutdown_complete.
    worker = threading.Thread(target=_worker_thread_entry, name="cli-worker", daemon=True)
    worker.start()

    # Main thread parks here so signal handlers run in this thread.
    # We wait either for the worker to finish or for a shutdown to be
    # requested; on shutdown we actively close the driver (to break it out
    # of any blocking read_until inside send_turn) and then wait for the
    # worker thread to drain.
    driver_force_closed = False
    while True:
        if _shutdown_complete.wait(timeout=0.5):
            break
        if _shutdown_requested.is_set():
            # Force-close the driver from the main thread. This terminates
            # the PTY child, which makes the worker's read_until see EOF
            # / child_dead and return promptly.
            if not driver_force_closed:
                driver_force_closed = True
                with _active_driver_lock:
                    drv = _active_driver
                if drv is not None:
                    try:
                        drv.close()
                    except Exception as exc:
                        emit_log("error", f"force-close driver failed: {exc!r}")
            # Wait up to 8s for graceful teardown.
            if _shutdown_complete.wait(timeout=8.0):
                break
            emit_log("warn", "worker did not shut down within grace, forcing exit")
            break

    final_reason = _shutdown_reason
    final_detail = _shutdown_detail
    if worker_exc is not None and final_reason == "shutdown":
        final_reason = "fatal"
        final_detail = repr(worker_exc)

    emit({"type": "exit", "reason": final_reason, "detail": final_detail})
    # Ensure stdout is fully flushed before exiting.
    try:
        sys.stdout.flush()
    except Exception:
        pass

    if final_reason == "fatal" or exit_code != 0:
        return exit_code or 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
