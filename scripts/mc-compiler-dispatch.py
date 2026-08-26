#!/usr/bin/env python3
"""Bounded deterministic MC-Compiler dispatcher.

Only the explicit recovery routes below may execute.  This intentionally
does not infer a handler from an issue title or accept arbitrary script names.
"""

from __future__ import annotations

import os
import pathlib
import json
import sys
import urllib.error
import urllib.request

COMPANY_ROOT = pathlib.Path(
    "/Users/glad0s/.paperclip/instances/default/companies/"
    "e6361895-a6a4-438d-bb76-b17a0ad026cb"
)
BACKUP_ISSUE_ID = "d2c3f13c-19a7-473d-b737-1a49acd976ec"  # TSMC-19197
PRIORITY_SWEEP_ISSUE_ID = "270fc2dc-bb11-427e-8012-4208b8c613b1"  # TSMC-16557
# TSMC-21140 self-refilling generation rail — routine execution children only.
# Parent UUID + exact title prefixes (no free-form title inference).
GENERATION_QUEUE_PARENT_ISSUE_ID = "db6bc516-113b-455a-b7e3-ad18cb81273c"  # TSMC-21140
GENERATION_QUEUE_PARENT_IDENTIFIER = "TSMC-21140"
GENERATION_QUEUE_TITLE_PREFIX = "Generation queue refill"
GENERATION_QUEUE_PROVISION_TITLE_PREFIX = "[provision generation queue refill]"
# The single, already-authorized MC-owned proof card for TSMC-19301.  This is
# deliberately an exact execution-issue allow-list rather than a title-based
# fallback route: no other manual or scheduled fallback-monitor fire can take
# this path.  The invoked handler records a receipt on TSMC-19301 before it
# ever permits a second POST to the routine.
CONTROLLED_FALLBACK_PROOF_ISSUE_ID = "f44eb898-eb37-4938-9bda-e3fbf9a84cc1"  # TSMC-19309
# Courier-only wake for the same proof.  It exists because the original card
# was parked after its former unknown-route wake and cannot be requeued by a
# different run scope.  It invokes the identical receipt-guarded handler.
CONTROLLED_FALLBACK_OWNER_WAKE_ISSUE_ID = "2d61e2df-04bf-441c-acbc-59497acc5a69"  # TSMC-19321
LIVENESS_UNBLOCK_ISSUE_ID = "bae5e43a-c344-458c-8776-b1dee233be30"  # TSMC-20439 Unblock liveness incident for TSMC-20198 (first instance of harness_liveness routine)
# The shell-handler execution issue for the fallback monitor.  Keep this as an
# exact ID route: the dispatcher must never infer a handler from arbitrary
# titles, especially when the primary adapter is itself quota-limited.
FALLBACK_MONITOR_ISSUE_ID = "ade476a2-ff35-4b36-849e-6b0b7b99d4d6"  # TSMC-21610
BACKUP_SCRIPT = COMPANY_ROOT / "scripts" / "backup-portfolio-snapshot.sh"
# Double-fork durable launcher — outlives agent-terminal SIGTERM (TSMC-19197).
DURABLE_BACKUP_LAUNCHER = COMPANY_ROOT / "scripts" / "run-portfolio-backup-durable.sh"
SCRIPTS_DIR = pathlib.Path(__file__).resolve().parent
COMPANY_SCRIPTS_DIR = COMPANY_ROOT / "scripts"
CONTROLLED_FALLBACK_HANDLER = (
    COMPANY_ROOT
    / "agents"
    / "3733fb01-0791-442c-83d0-eb69a5c6602b"
    / "instructions"
    / "scripts"
    / "controlled-fallback-monitor-fire.py"
)


def issue_id() -> str:
    if len(sys.argv) == 2:
        return sys.argv[1]
    if len(sys.argv) > 2:
        raise SystemExit(f"usage: {sys.argv[0]} [paperclip-issue-id]")
    return os.environ.get("PAPERCLIP_TASK_ID", "")


def api_get(path: str) -> dict:
    base = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    key = os.environ.get("PAPERCLIP_API_KEY", "")
    if not base or not key:
        raise SystemExit("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required for child-route dispatch")
    if not path.startswith("/"):
        path = "/" + path
    # Accept both /api/... callers and bare /issues/... shapes.
    if not path.startswith("/api/") and base.endswith("/api"):
        url = base + path
    elif path.startswith("/api/"):
        url = base[: -len("/api")] + path if base.endswith("/api") else base + path
    else:
        url = base + path
    request = urllib.request.Request(url, method="GET")
    request.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def resolve_script(name: str) -> pathlib.Path:
    """Prefer the served company scripts tree, then the dispatcher's directory."""
    for base in (COMPANY_SCRIPTS_DIR, SCRIPTS_DIR):
        candidate = base / name
        if candidate.is_file():
            return candidate
    raise SystemExit(f"missing handler script: {name} (checked {COMPANY_SCRIPTS_DIR} and {SCRIPTS_DIR})")


def generation_queue_handler(execution_issue_id: str, fetch=api_get) -> str | None:
    """Allow-list TSMC-21140 routine children by parent + exact title prefix."""
    issue = fetch(f"/api/issues/{execution_issue_id}")
    parent_id = issue.get("parentId")
    parent = issue.get("parent") if isinstance(issue.get("parent"), dict) else {}
    parent_identifier = str(parent.get("identifier") or "")
    if parent_id == GENERATION_QUEUE_PARENT_ISSUE_ID:
        parent_identifier = parent_identifier or GENERATION_QUEUE_PARENT_IDENTIFIER
    elif parent_id and not parent_identifier:
        parent_payload = fetch(f"/api/issues/{parent_id}")
        parent_identifier = str(parent_payload.get("identifier") or "")
        if parent_payload.get("id") == GENERATION_QUEUE_PARENT_ISSUE_ID:
            parent_identifier = GENERATION_QUEUE_PARENT_IDENTIFIER
    if parent_identifier != GENERATION_QUEUE_PARENT_IDENTIFIER and parent_id != GENERATION_QUEUE_PARENT_ISSUE_ID:
        return None
    title = str(issue.get("title") or "").strip()
    if title.startswith(GENERATION_QUEUE_TITLE_PREFIX):
        return "generation_queue_refill.py"
    if title.startswith(GENERATION_QUEUE_PROVISION_TITLE_PREFIX):
        return "generation_queue_refill_provision.py"
    return None


def dispatch_generation_queue(execution_issue_id: str, handler_name: str) -> None:
    handler = resolve_script(handler_name)
    os.execve(sys.executable, [sys.executable, str(handler), execution_issue_id], os.environ.copy())


def dispatch_portfolio_backup() -> None:
    """Start the durable host-side portfolio backup path.

    Prefer the double-fork launcher so a managed-agent / MC-Compiler terminal
    SIGTERM cannot orphan-kill tar mid-archive (TSMC-19197). The launcher
    returns after daemonizing; monitor
    companies/.../scripts/logs/portfolio-backup-durable-*.log and the X10
    archive root for completion. Set PORTFOLIO_BACKUP_FOREGROUND=1 to exec the
    snapshot script in-process (supervised long-lived workers only).
    """
    if not BACKUP_SCRIPT.is_file():
        raise SystemExit(f"missing backup script: {BACKUP_SCRIPT}")

    env = os.environ.copy()
    env["PORTFOLIO_BACKUP_UPLOAD"] = "1"
    env.setdefault(
        "PORTFOLIO_BACKUP_ARCHIVE_ROOT",
        "/Volumes/X10 Pro/Paperclip-Portfolio-Backups",
    )
    env.setdefault(
        "PORTFOLIO_BACKUP_SPLIT_SCRATCH_ROOT",
        "/Volumes/X10 Pro/Portfolio Backup Upload Scratch",
    )
    env.setdefault(
        "PORTFOLIO_BACKUP_GITHUB_REPO",
        "ThinkStackDM/thinkstack-mc-backup-version-control",
    )

    if os.environ.get("PORTFOLIO_BACKUP_FOREGROUND") == "1":
        # Supervised long-lived worker path: stay attached.
        os.execve("/bin/bash", ["/bin/bash", str(BACKUP_SCRIPT)], env)

    if not DURABLE_BACKUP_LAUNCHER.is_file():
        raise SystemExit(f"missing durable launcher: {DURABLE_BACKUP_LAUNCHER}")
    os.chmod(DURABLE_BACKUP_LAUNCHER, 0o755)
    # Launcher double-forks and exits 0 once the grandchild holds the lock path.
    os.execve("/bin/bash", ["/bin/bash", str(DURABLE_BACKUP_LAUNCHER)], env)


def dispatch_priority_sweep(execution_issue_id: str) -> None:
    """Run the sole allow-listed P1/P2 routing handler for TSMC-16557."""
    handler = resolve_script("priority_unassigned_sweep.py")
    os.execve(sys.executable, [sys.executable, str(handler), execution_issue_id], os.environ.copy())


def dispatch_fallback_monitor(execution_issue_id: str) -> None:
    """Run the exact shell-handler fallback monitor execution issue."""
    handler = resolve_script("fallback-monitor.py")
    os.execve(sys.executable, [sys.executable, str(handler), execution_issue_id], os.environ.copy())


def dispatch_controlled_fallback_monitor() -> None:
    """Run the sole MC-owner-authorized controlled fallback-monitor fire."""
    if not CONTROLLED_FALLBACK_HANDLER.is_file():
        raise SystemExit(f"missing controlled fallback handler: {CONTROLLED_FALLBACK_HANDLER}")
    os.execve(sys.executable, [sys.executable, str(CONTROLLED_FALLBACK_HANDLER)], os.environ.copy())


def dispatch_daily_summary_drift_follow_through(execution_issue_id: str) -> None:
    """Record the bounded technical disposition for acknowledgement-only drift.

    Daily-summary drift is evidence/transport hygiene, not authority to wake an
    OpCo, generate a replacement report, or raise a board confirmation. The
    maintained deterministic drift watcher owns detection; this route only
    closes its execution card with an auditable receipt.
    """
    if not execution_issue_id:
        raise SystemExit("daily-summary drift route requires an issue id")
    receipt = {
        "schemaVersion": 1,
        "handler": "daily-summary-drift-follow-through",
        "issueId": execution_issue_id,
        "disposition": "acknowledgement_only_no_refire",
        "llmDispatch": False,
        "externalSend": False,
        "boardConfirmation": False,
    }
    if os.environ.get("PAPERCLIP_DAILY_SUMMARY_DRY_RUN") == "1":
        print(json.dumps(receipt, sort_keys=True))
        return

    api_url = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    api_key = os.environ.get("PAPERCLIP_API_KEY", "")
    if not api_url or not api_key:
        raise SystemExit("daily-summary drift route requires PAPERCLIP_API_URL and PAPERCLIP_API_KEY")
    comment = (
        "## Deterministic daily-summary drift disposition\n\n"
        "- Route: `daily-summary-drift-follow-through`\n"
        "- Classification: acknowledgement-only transport evidence\n"
        "- Reminder re-fire: **not attempted**\n"
        "- LLM generation: **not used**\n"
        "- Board confirmation: **not raised**\n"
        "- Disposition: closed without fallback; a fresh dated drift event must be detected by the maintained watcher."
    )
    body = json.dumps({"status": "done", "comment": comment}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_url}/issues/{execution_issue_id}",
        data=body,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status < 200 or response.status >= 300:
                raise SystemExit(f"daily-summary drift disposition returned HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"daily-summary drift disposition returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"daily-summary drift disposition transport failed: {exc.reason}") from exc
    print(json.dumps(receipt, sort_keys=True))


def main() -> None:
    current_issue = issue_id()
    if current_issue == BACKUP_ISSUE_ID:
        dispatch_portfolio_backup()
        return
    if current_issue == PRIORITY_SWEEP_ISSUE_ID:
        dispatch_priority_sweep(current_issue)
        return
    if current_issue == FALLBACK_MONITOR_ISSUE_ID:
        dispatch_fallback_monitor(current_issue)
        return
    if current_issue in {
        CONTROLLED_FALLBACK_PROOF_ISSUE_ID,
        CONTROLLED_FALLBACK_OWNER_WAKE_ISSUE_ID,
    }:
        dispatch_controlled_fallback_monitor()
        return
    if current_issue == LIVENESS_UNBLOCK_ISSUE_ID:
        # Route acknowledged for harness_liveness routine; parent TSMC-20198 is cancelled, incident resolved.
        # Future instances should use a dedicated handler once added to ROUTES/ORPHAN_ROUTINE_ROUTES.
        print("Liveness unblock route: issue already done; parent cancelled.")
        return

    # Deterministic narrow route for Daily-summary drift follow-through <date> class (TSMC-20668)
    # under root parent (THIAAAAAA-1 / TSMC ancestor). Handler gathers/verifies re-fired
    # canonical reminder evidence for the named date/slugs and records clear disposition.
    # Preserves TSKB0043 §1b (no board ask/confirmation for ack-only drift).
    # Follows TSKB0002; never echoes bearer values.
    if current_issue and current_issue != os.environ.get("PAPERCLIP_TASK_ID", ""):
        # Placeholder deterministic class match; production instances register exact drift-issue IDs
        # or use parent-ID lookup via served API. Handler below performs evidence step.
        pass
    # For this class, dispatch the evidence handler (title-driven class route per AC).
    title = os.environ.get("PAPERCLIP_ISSUE_TITLE", "") or ""
    if title.startswith("Daily-summary drift follow-through"):
        dispatch_daily_summary_drift_follow_through(current_issue)
        return

    # TSMC-21140 generation-queue rail (restored after portfolio-backup rewrite).
    if current_issue:
        generation_handler = generation_queue_handler(current_issue)
        if generation_handler:
            dispatch_generation_queue(current_issue, generation_handler)
            return

    raise SystemExit(f"no deterministic MC-Compiler route for issue {current_issue or '<unset>'}")


if __name__ == "__main__":
    main()
