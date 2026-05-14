"""Bug-close Touch Index polling worker + webhook handler — thin CLI wrapper.

Sets up the environment (sys.path, .env) then delegates to the unified
Touch Index CLI (``python -m touch_index bug``).

Polling mode (default):
  Queries Paperclip for all done non-FDR issues closed in the last 30 minutes
  (overlap window to avoid gaps), then upserts to touch_index_bug_files for
  those that have git fix commits.  FDR-labelled issues are skipped (handled
  by the FR worker).

Webhook mode (--issue-id):
  Processes a single non-FDR issue by UUID (triggered by Paperclip
  issue_status_changed webhook events).  The issue is fetched from the
  Paperclip API and ingested immediately.

Usage:
    python scripts/run_touch_index_bug_worker.py [--lookback-minutes N] [--dry-run] [--validate]
    python scripts/run_touch_index_bug_worker.py --issue-id <uuid> [--dry-run]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")


def main() -> None:
    """Set up environment and delegate to the unified bug worker CLI."""
    from touch_index.bug_worker import main as bug_main

    bug_main()


if __name__ == "__main__":
    main()
