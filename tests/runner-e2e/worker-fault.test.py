import contextlib
import io
import json
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

HELPER = str(Path(__file__).with_name("worker-fault.py"))


class FaultIdentityTests(unittest.TestCase):
    def invoke(self, expected="1234", run="fixture-run", live_pid="43210", mode="kill"):
        def fake_open(name, *args, **kwargs):
            if name.endswith("/stat"):
                return io.StringIO("43210 (worker) " + " ".join(["S"] + ["0"] * 18 + ["1234"]))
            if name.endswith("/cmdline"):
                return io.BytesIO(b"node\0runner\0--run-id\0fixture-run\0")
            if "/fdinfo/" in name:
                return io.StringIO("Pid:\t" + live_pid + "\n")
            raise AssertionError(name)
        with patch.object(sys, "platform", "linux"), patch.object(sys, "argv", [HELPER, mode, "43210", run, expected]), \
             patch("os.pidfd_open", return_value=42, create=True) as opened, \
             patch("signal.pidfd_send_signal", create=True) as sent, patch("os.close") as closed, \
             patch("builtins.open", fake_open), contextlib.redirect_stdout(io.StringIO()):
            try:
                runpy.run_path(HELPER, run_name="__main__")
            except RuntimeError:
                sent.assert_not_called()
                closed.assert_called_once_with(42)
                raise
            opened.assert_called_once_with(43210)
            closed.assert_called_once_with(42)
            if mode == "kill":
                sent.assert_called_once_with(42, signal.SIGKILL, None, 0)
            else:
                sent.assert_not_called()

    def test_signals_owned_handle_not_numeric_pid(self):
        self.invoke()

    def test_inspection_does_not_signal(self):
        self.invoke(mode="inspect")

    def test_refuses_changed_start_identity(self):
        with self.assertRaisesRegex(RuntimeError, "start identity changed"):
            self.invoke(expected="earlier-process")

    def test_refuses_wrong_run(self):
        with self.assertRaisesRegex(RuntimeError, "run ID"):
            self.invoke(run="other-run")

    def test_refuses_dead_original_handle_even_if_pid_was_reused(self):
        with self.assertRaisesRegex(RuntimeError, "exited"):
            self.invoke(live_pid="-1")

    @unittest.skipUnless(sys.platform == "linux", "Real pidfd fault qualification runs on Linux CI")
    def test_real_owned_child_with_wrong_then_correct_start_identity(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "--run-id", "fault-test"])
        try:
            args = [sys.executable, HELPER]
            identity = json.loads(subprocess.check_output(args + ["inspect", str(child.pid), "fault-test"]))
            wrong = subprocess.run(args + ["kill", str(child.pid), "fault-test", "wrong"], capture_output=True)
            self.assertNotEqual(wrong.returncode, 0)
            self.assertIsNone(child.poll())
            result = json.loads(subprocess.check_output(args + ["kill", str(child.pid), "fault-test", identity["startTicks"]]))
            self.assertTrue(result["signalled"])
            self.assertEqual(child.wait(timeout=5), -signal.SIGKILL)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
