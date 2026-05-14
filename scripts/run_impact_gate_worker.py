#!/usr/bin/env python3
"""Impact Gate CLI wrapper — thin entry point for the polling worker.

Sets up the environment (sys.path, .env) then delegates to the
Impact Gate worker module.

Polling mode (default):
    Queries Paperclip for all done issues, runs the impact gate
    to verify fix commits reference the issue with real source files.

Webhook mode (--issue-id):
    Gates a single issue by UUID (triggered by Paperclip
    issue_status_changed webhook events).

Usage:
    python scripts/run_impact_gate_worker.py [--lookback-minutes N] [--dry-run]
    python scripts/run_impact_gate_worker.py --issue-id <uuid> [--dry-run]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")


def main() -> None:
    from impact_gate.worker import main as worker_main
    worker_main()


if __name__ == "__main__":
    main()
