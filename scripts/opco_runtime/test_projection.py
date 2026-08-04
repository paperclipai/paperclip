"""Focused tests for served OpCo runtime projection gates."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


RUNTIME = Path(__file__).resolve().parent


class ProjectionTests(unittest.TestCase):
    def test_all_artifacts_pass_preflight(self) -> None:
        result = subprocess.run(
            [sys.executable, str(RUNTIME / "dispatch.py"), "--preflight"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("projection ready", result.stdout)

    def test_missing_artifact_blocks_routine_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_runtime = Path(temp) / "opco_runtime"
            temp_runtime.mkdir()
            for name in ("dispatch.py", "projection.py"):
                (temp_runtime / name).write_text((RUNTIME / name).read_text())
            marker = Path(temp) / "must-not-exist"
            result = subprocess.run(
                [sys.executable, str(temp_runtime / "dispatch.py"), "--company", "kiss",
                 "--routine-command", sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"],
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin"},
            )
            self.assertEqual(result.returncode, 1)
            self.assertFalse(marker.exists())
            self.assertIn("projection incomplete", result.stderr)

    def test_dispatches_bounded_kiss_and_capital_commands(self) -> None:
        for company in ("kiss", "capital"):
            result = subprocess.run(
                [sys.executable, str(RUNTIME / "dispatch.py"), "--company", company,
                 "--routine-command", sys.executable, "-c", "print('bounded routine ok')"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("bounded routine ok", result.stdout)

    def test_swap_back_and_mc_inbound_are_gated_and_reachable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            payload = Path(temp) / "payload.json"
            payload.write_text('{"company":"kiss"}')
            for script, args in (
                ("swap_back.py", ["--swap-command", sys.executable, "-c", "print('swap ok')"]),
                ("mc_inbound.py", ["--payload", str(payload), "--dispatch-command", sys.executable,
                                   "-c", "print('inbound ok')"]),
            ):
                result = subprocess.run([sys.executable, str(RUNTIME / script), *args], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
