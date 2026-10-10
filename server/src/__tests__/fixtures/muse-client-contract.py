"""Exercise the shipped client with synthetic responses; never contacts a provider."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.dont_write_bytecode = True
client_path = Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location("muse_client", client_path)
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)
BINDING = "10000000-0000-4000-8000-000000000001"
ASSIGNMENT = "20000000-0000-4000-8000-000000000001"
ORIGIN = "https://paperclip.invalid"


def credentials(suffix="initial"):
    return {
        "version": 1, "bindingId": BINDING, "generation": 1,
        "companyId": "30000000-0000-4000-8000-000000000001",
        "agentId": "40000000-0000-4000-8000-000000000001",
        "accessToken": "synthetic-access-" + suffix,
        "accessExpiresAt": "2099-01-01T00:00:00Z",
        "refreshToken": "synthetic-refresh-" + suffix,
        "refreshExpiresAt": "2099-02-01T00:00:00Z",
        "signalToken": "synthetic-signal-" + suffix,
        "cleanupToken": "synthetic-cleanup-" + suffix,
        "detectorCleanupToken": "synthetic-detector-cleanup-" + suffix,
    }


class ClientContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="muse-client-contract-")
        self.root_patch = patch.object(client_module, "ROOT", Path(self.temporary.name) / ".config/paperclip-muse")
        self.root_patch.start()
        self.client = client_module.Client(BINDING)
        self.client.store_credentials(credentials(), ORIGIN)

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def reopen(self):
        self.client.close()
        self.client = client_module.Client(BINDING)

    def test_detector_never_reads_worker_credentials(self):
        signal = json.loads((self.client.directory / "signal.json").read_text())
        self.assertEqual(set(signal), {"origin", "bindingId", "generation", "signalToken", "detectorCleanupToken"})
        for path in (self.client.path, self.client.directory / "signal.json"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.client.directory.stat().st_mode), 0o700)
        self.assertEqual(self.client.config["accessToken"], credentials()["accessToken"])

    def test_lost_ack_reuses_persisted_identity_and_rejects_changed_effect(self):
        requests = []
        command = {"command": "tool", "assignmentId": ASSIGNMENT, "name": "paperclip_document_upsert", "arguments": {"key": "report", "body": "Synthetic evidence"}}

        def transport(url, body=None, token=None):
            requests.append(copy.deepcopy(body))
            if len(requests) == 1:
                raise RuntimeError("Synthetic response lost after server acceptance")
            return {"status": "completed", "receiptId": "synthetic-receipt"}

        with patch.object(client_module, "http", transport):
            with self.assertRaisesRegex(RuntimeError, "Synthetic response lost"):
                self.client.command("document:report:1", command)
            self.reopen()
            result = self.client.command("document:report:1", command)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(requests[0], requests[1])
            self.assertTrue(requests[0]["requestId"])
            self.client.command("document:report:1", command)
            self.assertEqual(len(requests), 2)
            with self.assertRaisesRegex(RuntimeError, "different input"):
                self.client.command("document:report:1", {**command, "arguments": {"key": "report", "body": "Changed effect"}})
            self.assertEqual(len(requests), 2)

    def test_unknown_receipt_blocks_automatic_repetition(self):
        with patch.object(client_module, "http", return_value={"status": "unknown", "canReplay": False}) as transport:
            command = {"command": "accept", "assignmentId": ASSIGNMENT}
            self.assertEqual(self.client.command("accept:1", command)["status"], "unknown")
            self.reopen()
            with self.assertRaisesRegex(RuntimeError, "unresolved"):
                self.client.command("accept:1", command)
            self.assertEqual(transport.call_count, 1)

    def test_private_cleanup_keeps_identity_after_lost_ack_and_separates_confirmation(self):
        calls = []

        def transport(url, body=None, token=None):
            calls.append((url, copy.deepcopy(body), token))
            if len(calls) == 1:
                raise RuntimeError("Synthetic cleanup acknowledgement lost")
            return {"cleanupStatus": "confirmed" if body.get("detectorRemoved") else "requested"}

        with patch.object(client_module, "http", transport):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement lost"):
                self.client.detector_cleanup(False)
            self.reopen()
            self.assertEqual(self.client.detector_cleanup(False)["cleanupStatus"], "requested")
            self.assertEqual(calls[0], calls[1])
            self.assertEqual(calls[1][2], credentials()["detectorCleanupToken"])
            self.assertTrue(calls[1][1]["detectorRemovalRequested"])
            self.assertNotIn("detectorRemoved", calls[1][1])
            self.client.detector_cleanup(False)
            self.assertEqual(len(calls), 2)
            self.assertEqual(self.client.detector_cleanup(True)["cleanupStatus"], "confirmed")
            self.assertNotEqual(calls[1][1]["requestId"], calls[2][1]["requestId"])
            self.assertTrue(calls[2][1]["detectorRemoved"])
            self.assertNotIn("detectorRemovalRequested", calls[2][1])

    def test_cleanup_after_reconnect_has_new_authority_and_identity(self):
        calls = []

        def transport(url, body=None, token=None):
            calls.append((copy.deepcopy(body), token))
            return {"cleanupStatus": "requested"}

        with patch.object(client_module, "http", transport):
            self.client.detector_cleanup(False)
            renewed = {**credentials("renewed"), "generation": 2}
            self.client.store_credentials(renewed, ORIGIN)
            self.reopen()
            self.client.detector_cleanup(False)
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[1][0]["generation"], 2)
            self.assertEqual(calls[1][1], renewed["detectorCleanupToken"])
            self.assertNotEqual(calls[0][0]["requestId"], calls[1][0]["requestId"])
            self.client.detector_cleanup(False)
            self.assertEqual(len(calls), 2)

    def test_canonical_answer_is_persisted_before_ingestion_receipt(self):
        response = {"assignmentId": ASSIGNMENT, "bindingId": BINDING, "generation": 1, "requestId": "question-one", "turnId": "turn-one", "inputDigest": "sha256:" + "a" * 64,
                    "response": {"answers": [{"questionId": "format", "answer": "Markdown"}]}, "consumed": False}
        calls = []

        def transport(url, body=None, token=None):
            calls.append(copy.deepcopy(body))
            if body.get("query") == "input.pending":
                return copy.deepcopy(response)
            persisted = json.loads((self.client.directory / "continuations" / (ASSIGNMENT + ".json")).read_text())
            self.assertEqual(body["continuationReceiptId"], persisted["inputs"]["question-one"]["continuationReceiptId"])
            self.assertTrue(body["continuationPersisted"])
            self.assertEqual(body["inputDigest"], response["inputDigest"])
            return {"status": "consumed"}

        with patch.object(client_module, "http", transport):
            answer = self.client.answer(ASSIGNMENT, "question-one")
            self.assertEqual([call.get("command") for call in calls], [None])
            self.reopen()
            self.assertEqual(self.client.answer(ASSIGNMENT, "question-one")["continuationReceiptId"], answer["continuationReceiptId"])
            self.assertEqual(self.client.consume(ASSIGNMENT, "question-one")["status"], "consumed")
            response["inputDigest"] = "sha256:" + "b" * 64
            with self.assertRaisesRegex(RuntimeError, "Input changed"):
                self.client.answer(ASSIGNMENT, "question-one")

    def test_uncertain_refresh_requires_reconnect_without_replaying_rotation(self):
        expired = credentials()
        expired["accessExpiresAt"] = "2000-01-01T00:00:00Z"
        self.client.store_credentials(expired, ORIGIN)
        with patch.object(client_module, "http", side_effect=RuntimeError("Synthetic lost rotation response")) as transport:
            with self.assertRaisesRegex(RuntimeError, "Refresh outcome uncertain"):
                self.client.access()
            self.reopen()
            with self.assertRaisesRegex(RuntimeError, "Reconnect Muse"):
                self.client.access()
            self.assertEqual(transport.call_count, 1)

    def test_interrupted_credential_publication_recovers_both_profiles(self):
        original_save = client_module.save
        rotated = credentials("rotated")

        def fail_signal_publish(path, value):
            if path.name == "signal.json":
                raise OSError("Synthetic interruption after publishing worker credentials")
            original_save(path, value)

        with patch.object(client_module, "save", fail_signal_publish):
            with self.assertRaises(OSError):
                self.client.store_credentials(rotated, ORIGIN)
        self.assertTrue((self.client.directory / "credential-commit.json").exists())
        with patch.object(client_module, "http", side_effect=AssertionError("Recovery must not replay refresh")):
            self.reopen()
            self.assertEqual(self.client.access(), rotated["accessToken"])
        signal = json.loads((self.client.directory / "signal.json").read_text())
        self.assertEqual(signal["signalToken"], rotated["signalToken"])
        self.assertNotIn("accessToken", signal)
        self.assertFalse((self.client.directory / "credential-commit.json").exists())

    def test_receipt_helper_inspects_original_identity_after_lost_ack(self):
        requests = []

        def transport(url, body=None, token=None):
            requests.append(copy.deepcopy(body))
            if body.get("command"):
                raise RuntimeError("Synthetic lost acknowledgement")
            return {"status": "completed", "receiptId": "synthetic-receipt"}

        with patch.object(client_module, "http", transport):
            with self.assertRaises(RuntimeError):
                self.client.command("accept:lost", {"command": "accept", "assignmentId": ASSIGNMENT})
            self.reopen()
            result = self.client.receipt("accept:lost")
            self.assertEqual(result["receipt"]["status"], "completed")
            self.assertEqual(requests[1], {"version": 1, "query": "operation.receipt", "assignmentId": ASSIGNMENT, "requestId": requests[0]["requestId"]})
            self.assertEqual(sum("command" in body for body in requests), 1)

    def test_mailbox_keeps_unhandled_batch_until_explicit_ack(self):
        batch = {"bindingId": BINDING, "generation": 1, "items": [{"id": 12, "kind": "assignment", "references": {"assignmentId": ASSIGNMENT}}], "nextCursor": 12}
        queries = []

        def transport(url, body=None, token=None):
            queries.append(copy.deepcopy(body))
            if body["after"] == 12:
                return {"bindingId": BINDING, "generation": 1, "items": [], "nextCursor": 12}
            return copy.deepcopy(batch)

        with patch.object(client_module, "http", transport):
            self.assertEqual(self.client.mailbox(), batch)
            # Simulate loss of stdout: a new process must not acknowledge work
            # merely because a previous process saved the received page.
            self.reopen()
            self.assertEqual(self.client.mailbox(), batch)
            self.assertEqual([q["after"] for q in queries], [0, 0])
            with self.assertRaisesRegex(RuntimeError, "exact durably saved batch"):
                self.client.mailbox(acknowledge=13)
            self.client.mailbox(acknowledge=12)
            self.reopen()
            self.assertEqual(self.client.mailbox()["items"], [])
            self.assertEqual(queries[-1]["after"], 12)

    def test_answer_rejects_other_assignment_binding_generation_and_request(self):
        response = {"assignmentId": ASSIGNMENT, "bindingId": BINDING, "generation": 1,
                    "requestId": "question-one", "turnId": "turn-one", "inputDigest": "sha256:" + "a" * 64,
                    "response": {"answers": []}, "consumed": False}
        for field, value in (("assignmentId", BINDING), ("bindingId", ASSIGNMENT), ("generation", 2), ("requestId", "question-two")):
            with self.subTest(field=field), patch.object(client_module, "http", return_value={**response, field: value}):
                with self.assertRaisesRegex(RuntimeError, "exact assignment and turn"):
                    self.client.answer(ASSIGNMENT, "question-one")
                self.assertFalse((self.client.directory / "continuations" / (ASSIGNMENT + ".json")).exists())

    def run_detector(self):
        root = Path(self.temporary.name)
        runtime = root / "hook-runtime.sh"
        runtime.write_text('silent() { printf "SILENT:%s\\n" "$1"; }\nwake() { printf "WAKE:%s\\n" "$1"; }\ndisable_after_run() { printf "DISABLE\\n"; }\n')
        # Run the actual Bash and embedded Python. Only the Python filesystem
        # home and HTTPS transport are replaced; dry-run keeps Bash read-only.
        (root / "sitecustomize.py").write_text("""
import json, os
from pathlib import Path
from unittest.mock import Mock
import urllib.request
root = Path(os.environ['MUSE_DETECTOR_TEST_ROOT'])
Path.home = classmethod(lambda cls: root)
class Response:
    status = 200
    headers = Mock()
    headers.get_content_type.return_value = 'application/json'
    def __enter__(self): return self
    def __exit__(self, *args): return None
    def read(self, count): return b'{"version":1,"signal":null}'
class Opener:
    def open(self, request, timeout):
        with (root / 'requests.jsonl').open('a') as stream:
            stream.write(json.dumps({'url': request.full_url, 'authorization': request.get_header('Authorization')}) + '\\n')
        return Response()
urllib.request.build_opener = lambda *args: Opener()
""")
        result = subprocess.run(['bash', str(client_path.with_name('muse-detector.sh')), BINDING],
            env={**os.environ, 'PYTHONPATH': str(root), 'PYTHONDONTWRITEBYTECODE': '1',
                 'MUSE_DETECTOR_TEST_ROOT': str(root), 'HATCH_HOOK_RUNTIME': str(runtime), 'HATCH_HOOK_DRY_RUN': 'true'},
            check=True, text=True, capture_output=True, timeout=10)
        requests = root / 'requests.jsonl'
        return result.stdout, [json.loads(line) for line in requests.read_text().splitlines()] if requests.exists() else []

    def test_running_detector_skips_exclusive_credential_handoff(self):
        output, requests = self.run_detector()
        self.assertIn('SILENT:Credential handoff in progress', output)
        self.assertNotIn('WAKE:', output)
        self.assertNotIn('DISABLE', output)
        self.assertEqual(requests, [])

    def test_running_detector_stays_silent_after_interrupted_rotation(self):
        self.client.close()
        for marker in ('signal-suspended.json', 'credential-commit.json'):
            with self.subTest(marker=marker):
                pending = self.client.directory / marker
                # The detector checks existence only, not worker-secret content.
                pending.write_text('not parseable; synthetic private worker state')
                output, requests = self.run_detector()
                self.assertIn('SILENT:Credential handoff in progress', output)
                self.assertNotIn('WAKE:', output)
                self.assertEqual(requests, [])
                pending.unlink()

    def test_running_detector_uses_only_new_signal_profile_after_recovery(self):
        self.client.store_credentials(credentials('rotated'), ORIGIN)
        self.client.close()
        # Prove worker state is irrelevant to polling and cannot be transmitted.
        self.client.path.write_text('unreadable synthetic worker credential state')
        output, requests = self.run_detector()
        self.assertIn('SILENT:No queued work', output)
        self.assertNotIn('WAKE:', output)
        self.assertEqual(requests, [{'url': ORIGIN + '/api/muse/v1/signal', 'authorization': 'Bearer synthetic-signal-rotated'}])

    def test_http_errors_do_not_echo_url_or_credentials(self):
        sensitive_url = ORIGIN + "/api/muse/v1/queries"
        error = urllib.error.HTTPError(sensitive_url, 401, "synthetic-private-provider-detail", {}, None)
        with patch.object(client_module.HTTP, "open", side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                client_module.http(sensitive_url, {"query": "identify"}, "synthetic-access-credential")
            self.assertEqual(str(raised.exception), "Paperclip HTTP 401; inspect connection or receipt before retrying")
        error.close()

    def test_redirects_and_non_https_origins_are_rejected(self):
        for origin in ("http://paperclip.invalid", "https://user:secret@paperclip.invalid", "https://paperclip.invalid/path", "https://paperclip.invalid/?secret=x"):
            with self.assertRaises(RuntimeError):
                client_module.origin(origin)
        self.assertIsNone(client_module.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://elsewhere.invalid"))


if __name__ == "__main__":
    unittest.main()
