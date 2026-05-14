#!/usr/bin/env python3
"""Impact Gate Worker — enforce FR acceptance + bug regression gates for fix issues.

Triggered when a fix/bug issue transitions to ``in_review`` (or called directly
via ``--issue-id``).  The worker:

1. Checks for a CEO bypass approval label — skips gate if present.
2. Reads ``touchedFiles`` from the issue description.
3. Queries the Blast Radius Touch Index for ``fr_impact_set`` and ``regression_set``.
4. Runs the Impact Gate test suite (FR acceptance + bug regression tests).
5. Posts a structured comment with results.
6. On PASS: transitions issue to ``done``.
7. On FAIL: reverts issue to ``in_progress``, creates blocking sub-issues.
8. On runner error: posts escalation comment, does NOT revert.

Usage
-----
  python scripts/impact_gate_worker.py --issue-id <uuid>
  python scripts/impact_gate_worker.py --issue-id <uuid> --dry-run

Exit codes
----------
  0 — gate passed or bypassed
  1 — gate failed (tests failed or runner error)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / ".." / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".." / ".env")

from impact_gate.worker import process_issue

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("impact_gate_worker")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Impact Gate Worker — enforce FR acceptance + bug regression gates",
    )
    parser.add_argument(
        "--issue-id",
        type=str,
        required=True,
        metavar="UUID",
        help="Paperclip issue UUID of the fix/bug issue to gate",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log results but do not post comments or transition issues",
    )
    args = parser.parse_args()

    logger.info(
        "Starting Impact Gate for issue %s (dry_run=%s)",
        args.issue_id,
        args.dry_run,
    )

    result = process_issue(
        args.issue_id, dry_run=args.dry_run
    )
    print(json.dumps(result, indent=2))  # noqa: T201

    gate_status = result.get("gate_status", "ERROR")
    logger.info("Gate result for %s: %s", args.issue_id, gate_status)

    if gate_status in ("PASS", "BYPASSED", "SKIPPED"):
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
