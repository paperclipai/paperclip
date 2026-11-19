"""Check that verification helpers cannot take ownership of another checkout."""
import json
import os
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request


class OwnershipSafety(unittest.TestCase):
    def test_foreign_checkout_server_remains_alive(self):
        repo = Path(__file__).resolve().parents[4]
        helpers = repo / '.agents/skills/verify-paperclip/scripts'
        with tempfile.TemporaryDirectory(prefix='paperclip-ownership-test-') as temp:
            root = Path(temp)
            foreign = root / 'another-checkout'
            foreign.mkdir()
            server = subprocess.Popen(
                [sys.executable, '-u', '-c',
                 "from http.server import HTTPServer, BaseHTTPRequestHandler\n"
                 "class Handler(BaseHTTPRequestHandler):\n"
                 " def do_GET(self):\n"
                 "  self.send_response(200); self.end_headers(); self.wfile.write(b'foreign fixture alive')\n"
                 " def log_message(self, *args): pass\n"
                 "server = HTTPServer(('127.0.0.1', 0), Handler)\n"
                 "print(server.server_port, flush=True)\n"
                 "server.serve_forever()\n"],
                cwd=foreign, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True,
            )
            try:
                port = int(server.stdout.readline().strip())
                url = f'http://127.0.0.1:{port}'
                data = root / 'verification-data'
                instance = data / 'instances/default'
                instance.mkdir(parents=True)
                evidence = root / 'evidence'
                evidence.mkdir()
                # The claimed PID really owns this port, but its cwd is foreign.
                (evidence / 'launch.json').write_text(json.dumps({
                    'repo': str(repo), 'dataDir': str(data), 'port': port,
                    'url': url, 'launcherPid': server.pid,
                }))
                (instance / 'runtime-info.json').write_text(json.dumps({
                    'pid': server.pid, 'port': port, 'dashboardUrl': url,
                    'host': '127.0.0.1',
                }))
                for helper in ['doctor.py', 'stop.py']:
                    with self.subTest(helper=helper):
                        result = subprocess.run(
                            [sys.executable, str(helpers / helper),
                             '--evidence-dir', str(evidence)],
                            capture_output=True, text=True, timeout=10,
                        )
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('checkout', result.stdout + result.stderr)
                        self.assertIsNone(server.poll(), 'Helper killed foreign server')
                        with urllib.request.urlopen(url, timeout=5) as response:
                            self.assertEqual(response.read(), b'foreign fixture alive')
                self.assertFalse((evidence / 'cleanup.json').exists())
            finally:
                server.terminate()
                try:
                    server.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.communicate()


    def test_cleanup_waits_for_exit_after_listener_closes(self):
        repo = Path(__file__).resolve().parents[4]
        with tempfile.TemporaryDirectory(prefix='paperclip-delayed-exit-test-') as temp:
            root = Path(temp)
            instance = root / 'data/instances/default'
            instance.mkdir(parents=True)
            evidence = root / 'evidence'
            evidence.mkdir()
            marker = root / 'listener-closed'
            server = subprocess.Popen(
                [sys.executable, '-u', '-c',
                 "import signal, socket, sys, time\n"
                 "from pathlib import Path\n"
                 "listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen()\n"
                 "def stop(signum, frame):\n"
                 " listener.close(); Path(sys.argv[1]).write_text('closed')\n"
                 " time.sleep(2); sys.exit(0)\n"
                 "signal.signal(signal.SIGTERM, stop)\n"
                 "print(listener.getsockname()[1], flush=True)\n"
                 "signal.pause()\n", str(marker)],
                cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                port = int(server.stdout.readline().strip())
                url = f'http://127.0.0.1:{port}'
                (evidence / 'launch.json').write_text(json.dumps({
                    'repo': str(repo), 'dataDir': str(root / 'data'),
                    'port': port, 'url': url, 'launcherPid': os.getpid(),
                }))
                (instance / 'runtime-info.json').write_text(json.dumps({
                    'pid': server.pid, 'port': port, 'dashboardUrl': url,
                }))
                started = time.monotonic()
                result = subprocess.run(
                    [sys.executable, str(repo / '.agents/skills/verify-paperclip/scripts/stop.py'),
                     '--evidence-dir', str(evidence)],
                    capture_output=True, text=True, timeout=12,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(marker.exists(), 'Fixture did not close its listener')
                self.assertGreaterEqual(time.monotonic() - started, 2)
                self.assertEqual(server.poll(), 0, 'Cleanup returned before runtime exit')
                cleanup = json.loads((evidence / 'cleanup.json').read_text())
                self.assertTrue(cleanup['runtimeExited'])
            finally:
                if server.poll() is None:
                    server.kill()
                server.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
