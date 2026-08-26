#!/usr/bin/env python3

import json
import os
import pathlib
import subprocess
import sys
import unittest
import importlib.util
from datetime import datetime, timedelta, timezone
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).with_name("mc-compiler-dispatch.py")
SWEEP_SCRIPT = pathlib.Path(__file__).with_name("priority_unassigned_sweep.py")
SWEEP_SPEC = importlib.util.spec_from_file_location("priority_unassigned_sweep", SWEEP_SCRIPT)
assert SWEEP_SPEC and SWEEP_SPEC.loader
SWEEP = importlib.util.module_from_spec(SWEEP_SPEC)
SWEEP_SPEC.loader.exec_module(SWEEP)
DISPATCH_SPEC = importlib.util.spec_from_file_location("mc_compiler_dispatch", SCRIPT)
assert DISPATCH_SPEC and DISPATCH_SPEC.loader
DISPATCH = importlib.util.module_from_spec(DISPATCH_SPEC)
DISPATCH_SPEC.loader.exec_module(DISPATCH)


class McCompilerDispatchTest(unittest.TestCase):
    def test_priority_sweep_candidate_is_todo_high_or_critical_after_30_minutes(self) -> None:
        now = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
        issue = {
            "status": "todo",
            "priority": "high",
            "updatedAt": (now - timedelta(minutes=31)).isoformat(),
        }
        self.assertTrue(SWEEP.candidate(issue, now))
        self.assertFalse(SWEEP.candidate({**issue, "updatedAt": (now - timedelta(minutes=29)).isoformat()}, now))
        self.assertTrue(SWEEP.candidate({**issue, "priority": "critical"}, now))

    def test_priority_sweep_rejects_every_non_todo_state_and_assigned_issues(self) -> None:
        now = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
        base = {"priority": "high", "updatedAt": (now - timedelta(minutes=90)).isoformat()}
        for status in ("backlog", "in_progress", "blocked"):
            self.assertFalse(SWEEP.candidate({**base, "status": status}, now), status)
        self.assertFalse(SWEEP.candidate({**base, "status": "todo", "assigneeAgentId": "owner"}, now))

    def test_priority_sweep_missing_registry_never_falls_back_to_parked_claude_lane(self) -> None:
        parked = {"id": SWEEP.PARKED_CLAUDE_CEO_AGENT_ID, "name": "Claude CEO", "role": "CEO", "status": "idle"}
        with patch.object(SWEEP, "agent_running", return_value=False), patch.object(SWEEP, "api", return_value=[parked]):
            self.assertEqual(SWEEP.route_target("company-1"), (None, "unassigned"))

    def test_priority_sweep_selects_healthy_ceo_from_live_topology(self) -> None:
        live = {"id": "live-ceo", "name": "GLaD0S", "role": "CEO", "status": "running"}
        with patch.object(SWEEP, "agent_running", return_value=False), patch.object(SWEEP, "api", return_value=[live]):
            self.assertEqual(SWEEP.route_target("company-1"), ("live-ceo", "healthy CEO fallback"))

    def test_daily_summary_drift_route_is_bounded_and_dry_runnable(self) -> None:
        env = {
            **os.environ,
            "PAPERCLIP_DAILY_SUMMARY_DRY_RUN": "1",
            "PAPERCLIP_ISSUE_TITLE": "Daily-summary drift follow-through 2026-08-10",
        }
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "e4e35ebc-fa07-4e2f-b5f6-b495ff37b8c3"],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["handler"], "daily-summary-drift-follow-through")
        self.assertEqual(receipt["disposition"], "acknowledgement_only_no_refire")
        self.assertFalse(receipt["llmDispatch"])
        self.assertFalse(receipt["externalSend"])
        self.assertFalse(receipt["boardConfirmation"])

    def test_unknown_issue_still_fails_closed(self) -> None:
        unknown = "00000000-0000-0000-0000-000000000000"
        with patch.object(DISPATCH, "generation_queue_handler", return_value=None), patch.object(sys, "argv", [str(SCRIPT), unknown]):
            with self.assertRaisesRegex(SystemExit, "no deterministic MC-Compiler route"):
                DISPATCH.main()


if __name__ == "__main__":
    unittest.main()
