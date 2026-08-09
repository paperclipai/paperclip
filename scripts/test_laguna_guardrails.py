import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class RuntimeShaDriftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = load_script("runtime_sha_drift_check.py")

    def test_required_ancestor_failure_is_drift(self):
        result = self.script.evaluate_snapshot(
            live_sha="2ebc236b",
            target_sha="e57450356",
            required_ancestors=["e57450356"],
            ancestor_results={"e57450356": False},
            dropin_working_dir="/srv/staged",
            pid_cwd="/srv/live",
        )
        self.assertEqual(result["state"], "DRIFT")
        self.assertEqual(result["live_sha"], "2ebc236b")
        self.assertTrue(result["staged_but_not_restarted"])

    def test_green_requires_all_ancestors_and_matching_runtime_paths(self):
        result = self.script.evaluate_snapshot(
            live_sha="e57450356",
            target_sha="e57450356",
            required_ancestors=["e57450356"],
            ancestor_results={"e57450356": True},
            dropin_working_dir="/srv/live",
            pid_cwd="/srv/live",
        )
        self.assertEqual(result["state"], "GREEN")
        self.assertFalse(result["staged_but_not_restarted"])

    def test_alert_key_is_distinct_for_each_runtime_target_pair(self):
        first = self.script.alert_key("2ebc236b", "e57450356")
        second = self.script.alert_key("2ebc236c", "e57450356")
        self.assertNotEqual(first, second)

    def test_drift_alert_is_emitted_once_per_state(self):
        report = self.script.evaluate_snapshot(
            "2ebc236b",
            "e57450356",
            ["e57450356"],
            {"e57450356": False},
            "/staged",
            "/live",
        )
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"PAPERCLIP_RUNTIME_DRIFT_LEDGER": str(Path(directory) / "ledger.json")},
        ), patch.object(self.script, "request", return_value=(201, "ok")) as request:
            first = self.script.alert(report)
            second = self.script.alert(report)
        self.assertEqual(first["action"], "alerted")
        self.assertEqual(second["action"], "deduped")
        request.assert_called_once()


class LagunaWatchdogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = load_script("laguna_adapter_watchdog.py")

    def test_ollama_eviction_and_second_model_are_findings(self):
        findings = self.script.inspect_ollama(
            {"models": [{"name": "other:q4"}]},
            {"models": [{"name": "laguna-s-2.1:q4_K_M"}, {"name": "other:q4"}]},
            {"OLLAMA_MAX_LOADED_MODELS": "1"},
        )
        kinds = {finding["kind"] for finding in findings}
        self.assertIn("model_evicted", kinds)
        self.assertIn("second_model_loaded", kinds)
        self.assertIn("headroom_policy_violation", kinds)

    def test_agent_failure_and_ghost_running_are_findings(self):
        failed = self.script.inspect_agent(
            {"id": "agent-failed", "name": "Planner", "status": "error", "activeRunId": None}
        )
        ghost = self.script.inspect_agent(
            {"id": "agent-ghost", "name": "Director", "status": "running", "activeRunId": None}
        )
        self.assertEqual({finding["kind"] for finding in failed}, {"adapter_failed"})
        self.assertEqual({finding["kind"] for finding in ghost}, {"ghost_running"})

    def test_recovery_actions_request_only_and_are_bounded(self):
        findings = [
            {"kind": "adapter_failed", "agent_id": "agent-1", "agent_name": "Executor"},
            {"kind": "ghost_running", "agent_id": "agent-2", "agent_name": "Iterator"},
            {"kind": "second_model_loaded", "agent_id": None, "agent_name": None},
        ]
        actions = self.script.recovery_actions(findings, nudge_counts={"agent-1": 0, "agent-2": 2})
        self.assertEqual(sum(action["kind"] == "owner_wake" for action in actions), 1)
        self.assertEqual(sum(action["kind"] == "digest_surface" for action in actions), 1)
        self.assertEqual(sum(action["kind"] == "request" for action in actions), 2)
        serialized = json.dumps(actions).lower()
        self.assertNotIn("sudo", serialized)
        self.assertNotIn("clear-error", serialized)
        self.assertNotIn("terminate", serialized)


class ScriptSelfTests(unittest.TestCase):
    def test_python_selftests_are_green(self):
        for script in ("runtime_sha_drift_check.py", "laguna_adapter_watchdog.py"):
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / script), "selftest"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_cutover_selftest_is_green(self):
        result = subprocess.run(
            ["bash", str(ROOT / "scripts" / "runtime_cutover.sh"), "selftest"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
