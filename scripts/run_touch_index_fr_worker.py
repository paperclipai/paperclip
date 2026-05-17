"""FR Touch Index polling worker + webhook handler — thin CLI wrapper.

Sets up the environment (sys.path, .env) then delegates to the unified
Touch Index CLI (``python -m touch_index fr``).

Polling mode (default):
  Queries Paperclip for FDR issues updated in the last 30 minutes (overlap
  window to avoid gaps on late-firing routines), then upserts to
  touch_index_fr_files.

Webhook mode (--issue-id):
  Processes a single FDR issue by UUID (triggered by Paperclip
  issue_created/issue_updated webhook events).  The issue is fetched
  from the Paperclip API and ingested immediately.

Watermark strategy: the 30-minute look-back window with idempotent upsert
means we can re-process safely without state tracking.

Usage:
    python scripts/run_touch_index_fr_worker.py [--lookback-minutes N] [--dry-run] [--validate]
    python scripts/run_touch_index_fr_worker.py --issue-id <uuid> [--dry-run]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from touch_index.fr_worker import main as fr_main


def main() -> None:
    """Set up environment and delegate to the unified FR worker CLI."""
    fr_main()


if __name__ == "__main__":
    main()
