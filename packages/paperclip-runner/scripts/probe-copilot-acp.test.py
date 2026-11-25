"""Credential-free failure injection for the offline probe's resource ownership."""
import io
import json
import pathlib
import runpy
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from unittest.mock import Mock, patch

SCRIPT = pathlib.Path(__file__).with_name("probe-copilot-acp.py")
DIGEST = "a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3"


class ProbeCleanupTests(unittest.TestCase):
    def exercise(self, stage, broken_report=False, broken_stdin=False):
        with tempfile.TemporaryDirectory(prefix="copilot-probe-test-") as temporary:
            base = pathlib.Path(temporary)
            package = base / "package"
            package.mkdir()
            (package / "package.json").write_text(json.dumps({"name": "@github/copilot-darwin-arm64", "version": "1.0.88"}))
            (package / "copilot").write_bytes(b"fixture; never executed")
            workspace = base / "workspace"
            server = Mock(server_port=54321)
            process = Mock()
            process.stdout.fileno.return_value = 10
            process.stderr.fileno.return_value = 11
            if broken_stdin:
                process.stdin.close.side_effect = BrokenPipeError("closed")
            pending = []

            def write(raw):
                request = json.loads(raw)
                if request["method"] != stage:
                    result = {"sessionId": "session-1"} if request["method"] == "session/new" else {"stopReason": "end_turn"}
                    pending.append((json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}) + "\n").encode())
            process.stdin.write.side_effect = write
            process.wait.return_value = 0
            clock = iter(range(0, 1000, 10))
            dumps = json.dumps

            def serialize(value, *args, **kwargs):
                if broken_report and isinstance(value, dict) and value.get("schema") == "paperclip.copilot-acp-evidence/v1":
                    raise ValueError("report failed")
                return dumps(value, *args, **kwargs)

            def make_workspace(**_kwargs):
                workspace.mkdir()
                return str(workspace)

            with ExitStack() as patches, redirect_stdout(io.StringIO()):
                for target, value in [
                    ("sys.argv", [str(SCRIPT), "--package-root", str(package)]),
                    ("hashlib.sha256", Mock(return_value=Mock(hexdigest=lambda: DIGEST))),
                    ("tempfile.mkdtemp", make_workspace),
                    ("http.server.HTTPServer", Mock(return_value=server)),
                    ("threading.Thread", Mock()),
                    ("subprocess.Popen", Mock(side_effect=OSError("spawn failed")) if stage == "spawn" else Mock(return_value=process)),
                    ("time.monotonic", lambda: next(clock)),
                    ("select.select", lambda *_args: ([process.stdout] if pending else [], [], [])),
                    ("os.read", lambda *_args: pending.pop(0)),
                    ("json.dumps", serialize),
                ]:
                    patches.enter_context(patch(target, value))
                with self.assertRaisesRegex(OSError if stage == "spawn" else TimeoutError, "spawn failed" if stage == "spawn" else stage):
                    runpy.run_path(str(SCRIPT), run_name="__main__")
            self.assertFalse(workspace.exists())
            server.shutdown.assert_called_once()
            server.server_close.assert_called_once()
            if stage != "spawn":
                process.terminate.assert_called_once()
                process.wait.assert_called_once_with(timeout=5)
                process.stdout.close.assert_called_once()
                process.stderr.close.assert_called_once()

    def test_initialize_timeout(self):
        self.exercise("initialize")

    def test_session_creation_timeout(self):
        self.exercise("session/new")

    def test_report_failure_preserves_original_failure_and_cleanup(self):
        self.exercise("initialize", broken_report=True)

    def test_broken_input_pipe_does_not_skip_process_cleanup(self):
        self.exercise("session/new", broken_stdin=True)

    def test_spawn_failure_closes_server_and_workspace(self):
        self.exercise("spawn")


if __name__ == "__main__":
    unittest.main()
