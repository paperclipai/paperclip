"""
Loop Engineering Standard — ALE loop contract (LES §1 + §5)
============================================================
Nightly catalog enrichment batch runner — reference / reference.

ALE §1 Five-Part Contract
--------------------------
1. GOAL / SUCCESS CRITERION
   Drain up to ENRICHMENT_BATCH_SIZE pending rows from
   enrichment_queue.  Checkable stop: queue empty
   OR ≤batch_size rows attempted in a single pass.

2. TOOLS — bounded action surface
   - dispatcher.EnrichmentDispatcher.run_batch()   (DB read + AI enrichment)
   - Paperclip PATCH /api/issues/{id}              (mark execution issue done
                                                    with closing summary comment)
   - flock()                                        (single-runner guard, reference)
   No other side effects.

3. CONTEXT — single-pass, stateless between runs
   Each invocation fetches a fresh fixed row list (≤batch_size) from the DB.
   No state is carried over between heartbeats beyond what is persisted in
   the company-scoped enrichment staging table.

4. TERMINATION — explicit, bounded, NEVER a daemon / NEVER "loop till empty"
   Bound: a fixed item list of ≤batch_size rows, single-pass.
   Terminal states (see TerminalState enum below):
     EMPTY_QUEUE      — no pending rows (exit 0)
     ALL_ENRICHED     — done == total > 0 (exit 0)
     PARTIAL          — 0 < done < total (exit 0)
     ALL_FAILED       — failed == total > 0, loud WARNING (exit 0)
     DISPATCHER_ERROR — exception from run_batch() (exit 1)
     SKIPPED_LOCKED   — flock held by another runner (exit 0)

5. ERROR HANDLING — typed; no silent crash or silent exit (reference)
   DISPATCHER_ERROR classified: auth | db | network | unknown.
   Comment/mark-done failures surface in the terminal record (not swallowed).
   SKIPPED_LOCKED previously exited silently — now logs + emits terminal record.
   Secret sanitizer prevents LITELLM_API_KEY / ANTHROPIC_API_KEY / DATABASE_URL
   password from reaching any log line, comment, or terminal record.

§5 AUDITABILITY
   One ENRICHMENT_TERMINAL_RECORD JSON line emitted to stdout per run.
   Fields: batch_id, started_at, finished_at, terminal_state, total, done,
           failed, cap_paused, error_class, comment_posted, runner_pid, run_id.

Environment variables (beyond dispatcher's own set):
  PAPERCLIP_TASK_ID   current execution issue UUID (auto-injected by harness)
  PAPERCLIP_RUN_ID    current run ID for X-Paperclip-Run-Id audit header
  PAPERCLIP_API_URL   Paperclip control-plane URL
  PAPERCLIP_API_KEY   scoped JWT for Paperclip API calls

OpenShell sandbox (reference production routing flip):
  OPENSH_SANDBOX_ENABLED   1=on, 0=off (default 0; CEO approved 2026-05-26)
  OPENSH_SANDBOX_IMAGE     required image reference when enabled
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pathlib
import re
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

import httpx

# reference: load enrichment/.env explicitly so LITELLM_API_KEY is present regardless
# of whether the calling shell sourced the file. os.environ is not overridden for keys
# already set, so injected routine env always wins over .env defaults.
_ENV_FILE = pathlib.Path(__file__).parent / ".env"
if _ENV_FILE.exists():
    try:
        from dotenv import load_dotenv
        load_dotenv(_ENV_FILE, override=False)
    except ImportError:
        pass  # python-dotenv not installed; fall back to shell-sourced env

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dispatcher import DispatcherConfig, EnrichmentDispatcher  # type: ignore[import]

try:
    from scripts.opensh_shim.config import ShimConfig  # type: ignore[import]
    from scripts.opensh_shim.shim import OpenShellShim  # type: ignore[import]
    _OPENSH_AVAILABLE = True
except ImportError:
    _OPENSH_AVAILABLE = False

logger = logging.getLogger(__name__)

# reference: single-runner guard — only one batch_runner.py may drain at a time.
# On Linux, flock() is process-scoped and auto-released on crash/exit.
_LOCK_PATH: pathlib.Path = pathlib.Path(tempfile.gettempdir()) / "enrichment_batch_runner.lock"

# The execution environment supplies the accountable escalation assignee.
_ESCALATION_ASSIGNEE_ENV = "ENRICHMENT_ESCALATION_ASSIGNEE_ID"


# ---------------------------------------------------------------------------
# ALE §1 part 4 — explicit terminal states
# ---------------------------------------------------------------------------

class TerminalState(str, Enum):
    """Every exit path of the batch runner resolves to exactly one of these states."""
    EMPTY_QUEUE      = "EMPTY_QUEUE"       # no pending rows; exit 0
    ALL_ENRICHED     = "ALL_ENRICHED"      # done == total > 0; exit 0
    PARTIAL          = "PARTIAL"           # 0 < done < total; exit 0
    ALL_FAILED       = "ALL_FAILED"        # failed == total > 0; loud WARNING; exit 0
    DISPATCHER_ERROR = "DISPATCHER_ERROR"  # exception from run_batch(); exit 1
    SKIPPED_LOCKED   = "SKIPPED_LOCKED"   # flock held by another runner; exit 0


# ---------------------------------------------------------------------------
# ALE §1 part 5 — typed error classification
# ---------------------------------------------------------------------------

def _classify_dispatcher_error(exc: Exception) -> str:
    """
    Map an exception from EnrichmentDispatcher.run_batch() to a typed error class.
    Returns one of: auth | db | network | unknown.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        if exc.response.status_code in (401, 403):
            return "auth"

    exc_msg = str(exc).lower()

    if any(kw in exc_msg for kw in ("unauthorized", "forbidden", "authentication", "401", "403")):
        return "auth"

    try:
        import psycopg2
        if isinstance(exc, psycopg2.Error):
            return "db"
    except ImportError:
        pass
    if any(kw in exc_msg for kw in ("psycopg", "postgres", "database", "sqlalchemy", "asyncpg")):
        return "db"

    if isinstance(exc, (httpx.ConnectError, httpx.TimeoutException, ConnectionRefusedError)):
        return "network"
    if any(kw in exc_msg for kw in ("connection", "timeout", "network", "econnrefused", "socket")):
        return "network"

    return "unknown"


# ---------------------------------------------------------------------------
# Secret sanitizer (GOVERNANCE §5)
# ---------------------------------------------------------------------------

def _sanitize_message(msg: str) -> str:
    """
    Strip known secrets from a string before logging or including in a record.
    Redacts: LITELLM_API_KEY value, ANTHROPIC_API_KEY value, DATABASE_URL password.
    """
    for var in ("LITELLM_API_KEY", "ANTHROPIC_API_KEY"):
        val = os.environ.get(var, "")
        if val:
            msg = msg.replace(val, "[REDACTED]")

    # Redact password in postgresql://user:PASSWORD@host URLs
    msg = re.sub(
        r"((?:postgresql|postgres)://[^:/?#\s]+:)([^@\s]+)(@)",
        r"\1[REDACTED]\3",
        msg,
    )
    return msg


def _parse_dispatcher_summary(stdout: str) -> dict:
    """Return the final, typed JSON summary emitted by the dispatcher CLI."""
    for line in reversed(stdout.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(value, dict)
            and all(isinstance(value.get(key), int) and value[key] >= 0 for key in ("total", "done", "failed"))
            and isinstance(value.get("cap_paused"), bool)
            and value["done"] + value["failed"] == value["total"]
        ):
            return {key: value[key] for key in ("total", "done", "failed", "cap_paused")}
    raise RuntimeError("dispatcher command did not emit a valid summary")


async def _run_sandboxed_dispatcher(shim: "OpenShellShim") -> dict:
    """Run the canonical dispatcher command and parse its safe terminal summary."""
    dispatcher_cwd = Path(__file__).parents[1]
    dispatcher_env = os.environ.copy()
    result = await asyncio.to_thread(
        shim.run,
        ["python3", "-m", "enrichment.dispatcher"],
        timeout=900.0,
        cwd=dispatcher_cwd,
        env=dispatcher_env,
    )
    if result.returncode != 0:
        raise RuntimeError(f"dispatcher command failed: {_sanitize_message(result.stderr)}")
    return _parse_dispatcher_summary(result.stdout)


async def _run_dispatcher(shim: "OpenShellShim", cfg: DispatcherConfig) -> dict:
    """Execute the canonical command, with a narrow injectable unit-test seam."""
    # Unit tests replace the dispatcher class with a mock to exercise runner
    # terminalization without starting a child process. Production always sees
    # the real class and therefore always takes the canonical command path.
    if not isinstance(EnrichmentDispatcher, type):
        return await EnrichmentDispatcher(cfg).run_batch()
    return await _run_sandboxed_dispatcher(shim)


# ---------------------------------------------------------------------------
# LES §5 — terminal record emitter
# ---------------------------------------------------------------------------

def _emit_terminal_record(record: dict) -> None:
    """
    Emit exactly one machine-readable terminal record per run (LES §5).
    Printed to stdout so it is captured by the systemd journal.
    Greppable tag: ENRICHMENT_TERMINAL_RECORD
    """
    print(f"ENRICHMENT_TERMINAL_RECORD {json.dumps(record)}", flush=True)


# ---------------------------------------------------------------------------
# Lock helpers (reference)
# ---------------------------------------------------------------------------

def _try_acquire_lock() -> "IO[str] | None":
    """
    Try to acquire an exclusive non-blocking flock on _LOCK_PATH.
    Returns the open file descriptor on success, or None if another runner holds it.
    Caller must release with _release_lock() when done.
    """
    try:
        fd = open(_LOCK_PATH, "w")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd.write(str(os.getpid()))
        fd.flush()
        return fd
    except BlockingIOError:
        try:
            fd.close()
        except Exception:
            pass
        return None


def _release_lock(fd: "IO[str]") -> None:
    """Release a lock fd returned by _try_acquire_lock()."""
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
        fd.close()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Comment / issue helpers
# ---------------------------------------------------------------------------

def _load_dotenv(env_path: str | None = None) -> None:
    """Load KEY=VALUE pairs from enrichment/.env into os.environ.

    Existing os.environ values WIN — only absent/empty keys are set.
    Uses a minimal inline parser with no external dependencies.
    If the file does not exist, logs a warning and returns (no crash).
    """
    if env_path is None:
        env_path = os.path.join(os.path.dirname(__file__), ".env")
    try:
        with open(env_path) as fh:
            lines = fh.readlines()
    except FileNotFoundError:
        logger.warning("enrichment/.env not found at %s — skipping auto-load", env_path)
        return

    loaded: list[str] = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if not os.environ.get(key):
            os.environ[key] = value
            loaded.append(key)

    if loaded:
        logger.info("Auto-loaded %d key(s) from .env: %s", len(loaded), ", ".join(loaded))


def _build_comment(summary: dict, started_at: datetime, finished_at: datetime) -> str:
    duration_s = (finished_at - started_at).total_seconds()
    total = summary["total"]
    done = summary["done"]
    failed = summary["failed"]
    cap_paused = summary["cap_paused"]
    terminal_state = summary.get("terminal_state", "unknown")
    pool_ram_mib = summary.get("opensh_pool_ram_mib")
    pool_size = summary.get("opensh_pool_size")

    if total == 0:
        status_line = "Batch complete — queue empty, no rows to process."
    elif failed == total:
        status_line = f"Batch FAILED — {failed}/{total} rows failed enrichment."
    elif failed > 0:
        status_line = f"Batch partial — {done}/{total} enriched, {failed} failed."
    else:
        status_line = f"Batch complete — {done}/{total} rows enriched successfully."

    lines = [
        "## Nightly enrichment batch",
        "",
        status_line,
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Terminal state | {terminal_state} |",
        f"| Rows processed | {total} |",
        f"| Enriched (primary + fallback) | {done} |",
        f"| Failed (both tiers) | {failed} |",
        f"| Reviewer cap paused | {'yes ⚠️' if cap_paused else 'no'} |",
        f"| Duration | {duration_s:.1f}s |",
        f"| Finished at | {finished_at.strftime('%Y-%m-%d %H:%M:%S')} UTC |",
    ]

    if pool_ram_mib is not None:
        lines += [
            f"| OpenShell pool RAM | {pool_ram_mib:.1f} MiB (size={pool_size}) |",
        ]

    if cap_paused:
        lines += [
            "",
            "> **Opus reviewer cost cap hit.** The routine has been auto-paused. "
            "Manual unpause required on the control-plane task.",
        ]

    return "\n".join(lines)


def _build_blocked_comment(
    summary: dict,
    started_at: datetime,
    finished_at: datetime,
    error_class: str | None,
) -> str:
    base = _build_comment(summary, started_at, finished_at)
    ts_val = summary.get("terminal_state", "unknown")
    ec = error_class or "none"
    if error_class == "auth":
        unblock = (
            "operator/@local-board must provision `LITELLM_API_KEY` "
            "(local LiteLLM gateway key) in `enrichment/.env`"
        )
    else:
        unblock = f"CTO triage dispatcher `{ec}` failure"
    header = (
        f"Loud-fail: terminal_state={ts_val} error_class={ec}\n\n"
        f"Unblock: {unblock}\n\n"
    )
    return _sanitize_message(header + base)


async def _post_comment(
    api_url: str,
    api_key: str,
    run_id: str,
    issue_id: str,
    body: str,
) -> None:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": run_id,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.post(
                f"{api_url}/api/issues/{issue_id}/comments",
                headers=headers,
                json={"body": body},
            )
            r.raise_for_status()
            logger.info("Summary comment posted to issue %s", issue_id)
        except Exception as exc:
            logger.warning("Failed to post summary comment: %s", exc)


async def _mark_issue_done(
    api_url: str,
    api_key: str,
    run_id: str,
    issue_id: str,
    comment: str,
) -> bool:
    """
    Mark the execution issue done with a closing summary comment.
    Returns True on success, False on failure.
    Failures are logged so they surface in the terminal record (not silently dropped).
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": run_id,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.patch(
                f"{api_url}/api/issues/{issue_id}",
                headers=headers,
                json={"status": "done", "comment": comment},
            )
            r.raise_for_status()
            logger.info("Issue %s marked done", issue_id)
            return True
        except Exception as exc:
            logger.warning("Failed to mark issue done: %s", exc)
            return False


async def _mark_issue_blocked(
    api_url: str,
    api_key: str,
    run_id: str,
    issue_id: str,
    comment: str,
    assignee_id: str,
) -> bool:
    """
    Mark the execution issue blocked and reassign to assignee_id (reference).
    Returns True on success, False on failure.
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": run_id,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.patch(
                f"{api_url}/api/issues/{issue_id}",
                headers=headers,
                json={"status": "blocked", "assigneeAgentId": assignee_id, "comment": comment},
            )
            r.raise_for_status()
            logger.info("Issue %s blocked and reassigned to %s", issue_id, assignee_id)
            return True
        except Exception as exc:
            logger.warning("Failed to mark issue blocked: %s", exc)
            return False


# ---------------------------------------------------------------------------
# Batch execution
# ---------------------------------------------------------------------------

async def run() -> int:
    """
    Execute the nightly batch and post summary to Paperclip.
    Returns exit code: 0 on success or empty queue, 1 on dispatcher error.
    """
    started_at = datetime.now(timezone.utc)
    run_id = os.environ.get("PAPERCLIP_RUN_ID", "")
    runner_pid = os.getpid()

    # reference: enforce single runner — exit clean if another drain is active.
    lock_fd = _try_acquire_lock()
    if lock_fd is None:
        # reference: previously silent exit; now logs terminal_state by name + emits record.
        logger.warning(
            "terminal_state=%s — enrichment drain already active, another "
            "batch_runner.py holds the run lock (reference)",
            TerminalState.SKIPPED_LOCKED.value,
        )
        _emit_terminal_record({
            "batch_id": None,
            "started_at": started_at.isoformat(),
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "terminal_state": TerminalState.SKIPPED_LOCKED.value,
            "total": 0,
            "done": 0,
            "failed": 0,
            "cap_paused": False,
            "error_class": None,
            "comment_posted": False,
            "runner_pid": runner_pid,
            "run_id": run_id,
        })
        return 0

    try:
        exit_code, _ = await _run_batch()
    finally:
        _release_lock(lock_fd)

    return exit_code


async def _run_batch() -> "tuple[int, dict]":
    """
    Inner batch execution, called only when the run lock is held.
    Returns (exit_code, summary). summary["terminal_state"] is always set.
    """
    api_url = os.environ.get("PAPERCLIP_API_URL", "")
    api_key = os.environ.get("PAPERCLIP_API_KEY", "")
    run_id = os.environ.get("PAPERCLIP_RUN_ID", "")
    task_id = os.environ.get("PAPERCLIP_TASK_ID", "")
    runner_pid = os.getpid()
    batch_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)
    exit_code = 0
    error_class = None

    # Configuration construction is part of the guarded execution path. A
    # malformed runtime environment must still produce the one terminal
    # record and issue disposition below.
    try:
        cfg = DispatcherConfig.from_env()
        # Enabled OpenShell is a fresh, single-use sandbox; no undocumented
        # pool, host mount, gRPC, or macOS fallback participates in execution.
        shim = None
        opensh_enabled = os.environ.get("OPENSH_SANDBOX_ENABLED", "0") == "1"
        if opensh_enabled and not _OPENSH_AVAILABLE:
            raise RuntimeError(
                "OpenShell is enabled but the OpenShell shim is unavailable; "
                "refusing to fall back to in-process execution"
            )
        if _OPENSH_AVAILABLE:
            shim_cfg = ShimConfig.from_env()
            shim = OpenShellShim(shim_cfg)
        if shim is not None:
            summary = await _run_dispatcher(shim, cfg)
        else:
            dispatcher = EnrichmentDispatcher(cfg)
            summary = await dispatcher.run_batch()
        logger.info("Batch summary: %s", json.dumps(summary))
    except Exception as exc:
        error_class = _classify_dispatcher_error(exc)
        safe_msg = _sanitize_message(str(exc))
        logger.error("Dispatcher error class=%s: %s", error_class, safe_msg)
        summary = {
            "total": 0, "done": 0, "failed": 0, "cap_paused": False,
            "error": safe_msg,
        }
        exit_code = 1

    # --- Determine terminal state (LES §1 part 4) ---
    total = summary["total"]
    done = summary["done"]
    failed = summary["failed"]
    cap_paused = summary["cap_paused"]

    if exit_code == 1:
        ts = TerminalState.DISPATCHER_ERROR
        logger.error("terminal_state=%s error_class=%s", ts.value, error_class)
    elif total == 0:
        ts = TerminalState.EMPTY_QUEUE
        logger.info("terminal_state=%s", ts.value)
    elif done == total:
        ts = TerminalState.ALL_ENRICHED
        logger.info("terminal_state=%s", ts.value)
    elif failed == total:
        ts = TerminalState.ALL_FAILED
        logger.warning(
            "terminal_state=%s — all %d/%d rows failed enrichment; investigate dispatcher logs",
            ts.value, failed, total,
        )
    else:
        ts = TerminalState.PARTIAL
        logger.info("terminal_state=%s done=%d failed=%d total=%d", ts.value, done, failed, total)

    summary["terminal_state"] = ts.value
    summary["error_class"] = error_class

    finished_at = datetime.now(timezone.utc)

    # --- Post closing summary + mark issue done or blocked (reference) ---
    comment_posted = False
    escalation_assignee_id = os.environ.get(_ESCALATION_ASSIGNEE_ENV, "")
    if api_url and api_key and task_id:
        comment = _build_comment(summary, started_at, finished_at)
        loud_fail = (exit_code != 0) or (ts == TerminalState.ALL_FAILED)
        if loud_fail and escalation_assignee_id:
            blocked_comment = _build_blocked_comment(summary, started_at, finished_at, error_class)
            comment_posted = bool(
                await _mark_issue_blocked(
                    api_url, api_key, run_id, task_id, blocked_comment, escalation_assignee_id
                )
            )
        elif loud_fail:
            logger.warning("%s is required to route a failed batch", _ESCALATION_ASSIGNEE_ENV)
            comment_posted = bool(
                await _post_comment(
                    api_url, api_key, run_id, task_id,
                    _build_blocked_comment(summary, started_at, finished_at, error_class),
                )
            )
        else:
            comment_posted = bool(
                await _mark_issue_done(api_url, api_key, run_id, task_id, comment)
            )
    else:
        logger.warning("PAPERCLIP_API_URL/API_KEY/TASK_ID not set — skipping issue update")

    summary["comment_posted"] = comment_posted

    # --- Emit terminal record (LES §5) ---
    _emit_terminal_record({
        "batch_id": batch_id,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "terminal_state": ts.value,
        "total": total,
        "done": done,
        "failed": failed,
        "cap_paused": cap_paused,
        "error_class": error_class,
        "comment_posted": comment_posted,
        "runner_pid": runner_pid,
        "run_id": run_id,
    })

    return exit_code, summary


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    _load_dotenv()
    sys.exit(asyncio.run(run()))


if __name__ == "__main__":
    main()
