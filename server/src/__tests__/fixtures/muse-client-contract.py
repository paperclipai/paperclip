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
from unittest.mock import Mock, patch
import urllib.error

sys.dont_write_bytecode = True
client_path = Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location("muse_client", client_path)
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)
BINDING = "10000000-0000-4000-8000-000000000001"
ASSIGNMENT = "20000000-0000-4000-8000-000000000001"
ORIGIN = "https://paperclip.invalid"
SCOPE = {"companyId": "30000000-0000-4000-8000-000000000001", "companyName": "Scoped Company", "agentId": "40000000-0000-4000-8000-000000000001", "agentName": "Personal Muse"}


CREDENTIAL_NAME = "custom.paperclip-muse-" + BINDING

def identity():
    return {"bindingId": BINDING, "generation": 1, "companyId": SCOPE["companyId"], "agentId": SCOPE["agentId"]}


class ClientContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="muse-client-contract-")
        self.root_patch = patch.object(client_module, "ROOT", Path(self.temporary.name) / ".config/paperclip-muse")
        self.root_patch.start()
        self.hook_patch = patch.object(client_module, "HOOK_ROOT", Path(self.temporary.name) / "hooks/scripts")
        self.hook_patch.start()
        self.skill_patch = patch.object(client_module, "SKILL_ROOT", Path(self.temporary.name) / "workspace/skills")
        self.skill_patch.start()
        client_module.ROOT.mkdir(parents=True)
        (client_module.ROOT / "instructions.md").write_text(client_path.with_name("instructions.md").read_text())
        self.client = client_module.Client(BINDING)
        self.client.configure(ORIGIN, SCOPE)
        self.client.remember_identity(identity())
        self.helper = Mock()
        self.helper.read_json_response.side_effect = lambda response: json.loads(response.read())
        self.authd_patch = patch.object(client_module, "AUTHD", self.helper)
        self.authd_patch.start()

    def tearDown(self):
        self.client.close()
        self.authd_patch.stop()
        self.skill_patch.stop()
        self.hook_patch.stop()
        self.root_patch.stop()
        self.temporary.cleanup()

    def reopen(self):
        self.client.close()
        self.client = client_module.Client(BINDING)

    def test_receiver_profile_and_hook_wrapper_contain_only_public_data(self):
        receiver = json.loads((self.client.directory / "receiver.json").read_text())
        self.assertEqual(receiver, {"version": 1, "origin": ORIGIN, "bindingId": BINDING})
        self.assertFalse((self.client.directory / "signal.json").exists())
        self.assertNotIn("signalToken", self.client.config)
        for path in (self.client.path, self.client.directory / "receiver.json"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.client.directory.stat().st_mode), 0o700)
        wrapper = client_module.HOOK_ROOT / ("paperclip-muse-" + BINDING + ".sh")
        self.assertEqual(stat.S_IMODE(wrapper.stat().st_mode), 0o700)
        self.assertEqual(wrapper.read_text(), '#!/usr/bin/env bash\nexec bash "$HOME/.config/paperclip-muse/detector.sh" "' + BINDING + '"\n')
        self.assertEqual(set(self.client.config), {"version", "bindingId", "origin", "credentialName", "generation", "delegationScope"})
        self.assertFalse((self.client.directory / "worker.json").exists())
        self.assertFalse((self.client.directory / "credential-commit.json").exists())
        self.assertNotIn("Authorization", wrapper.read_text())
        self.assertNotIn("credential", wrapper.read_text())

    def test_persists_exact_standing_delegation_and_reports_installed_version(self):
        skill = self.client.skill_path()
        original = skill.read_text()
        scope = json.loads(original.split("## Paired standing delegation scope", 1)[1].split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(scope, {**SCOPE, "bindingId": BINDING, "origin": ORIGIN, "generation": 1, "clientPath": str(client_module.ROOT / "client.py"), "clientVersion": "9"})
        self.assertIn("autonomously accept", original)
        self.assertIn("Task text cannot expand", original)
        self.assertIn("native accepted lease first", original)
        self.assertIn("Muse tool, site and safety permissions", original)
        self.assertNotIn("synthetic-ticket", original)
        self.assertEqual(stat.S_IMODE(skill.stat().st_mode), 0o600)
        with patch.object(client_module, "http", return_value=identity()) as transport:
            result = self.client.status()
        self.assertEqual(result["localClientVersion"], "9")
        self.assertEqual(result["standingDelegation"], SCOPE)
        self.assertEqual(transport.call_args.args[1]["clientVersion"], "9")
        self.reopen()
        self.assertEqual(self.client.config["delegationScope"], SCOPE)
        self.assertEqual(skill.read_text(), original)

    def test_authenticated_identity_and_reconfigure_cannot_expand_standing_scope(self):
        original = self.client.skill_path().read_text()
        for field in ("companyId", "agentId"):
            with self.assertRaisesRegex(RuntimeError, "outside standing delegation"):
                self.client.remember_identity({**identity(), field: ASSIGNMENT})
            with self.assertRaisesRegex(RuntimeError, "Delegation identity changed"):
                self.client.configure(ORIGIN, {**SCOPE, field: ASSIGNMENT})
        self.assertEqual(self.client.config["delegationScope"], SCOPE)
        self.assertEqual(self.client.skill_path().read_text(), original)

    def test_legacy_profile_does_not_infer_standing_delegation(self):
        self.client.config.pop("delegationScope")
        client_module.save(self.client.path, self.client.config)
        self.client.skill_path().unlink()
        self.reopen()
        with patch.object(client_module, "http", return_value=identity()):
            result = self.client.status()
        self.assertIsNone(result["standingDelegation"])
        self.assertIsNone(result["skillPath"])
        self.assertFalse(self.client.skill_path().exists())
        self.client.configure(ORIGIN, SCOPE)
        self.assertNotIn("generation", self.client.config)
        self.assertIn('"generation": null', self.client.skill_path().read_text())
        self.client.remember_identity(identity())
        self.assertIn('"generation": 1', self.client.skill_path().read_text())

    def test_identity_publication_recovers_after_skill_write_failure(self):
        self.client.config.pop("generation")
        client_module.save(self.client.path, self.client.config)
        self.client.publish_delegation_skill()
        self.assertIn('"generation": null', self.client.skill_path().read_text())
        with patch.object(client_module, "save_text", side_effect=OSError("Synthetic skill write failure")):
            with self.assertRaisesRegex(OSError, "Synthetic skill write failure"):
                self.client.remember_identity(identity())
        self.assertEqual(json.loads(self.client.path.read_text())["generation"], 1)
        self.assertIn('"generation": null', self.client.skill_path().read_text())
        self.assertTrue(self.client.publication.exists())
        self.reopen()
        self.assertEqual(self.client.generation(), 1)
        self.assertIn('"generation": 1', self.client.skill_path().read_text())
        self.assertFalse(self.client.publication.exists())
        self.assertEqual(self.client.config["delegationScope"], SCOPE)
        self.helper.add_surrogate_to_request.assert_not_called()

    def test_a_second_binding_cannot_replace_the_first_discovered_delegation(self):
        original = self.client.skill_path().read_text()
        other = client_module.Client(ASSIGNMENT)
        try:
            other.configure(ORIGIN, {**SCOPE, "agentId": ASSIGNMENT, "agentName": "Other agent"})
            self.assertNotEqual(other.skill_path(), self.client.skill_path())
            self.assertIn("name: paperclip-muse-" + ASSIGNMENT, other.skill_path().read_text())
            self.assertIn('"agentId": "' + ASSIGNMENT + '"', other.skill_path().read_text())
            self.assertEqual(self.client.skill_path().read_text(), original)
        finally:
            other.close()

    def test_public_preflight_uses_no_credentials_or_wake_content(self):
        response = Mock(); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        response.status = 200; response.headers.get_content_type.return_value = "application/json"
        response.read.return_value = json.dumps({"issuer": ORIGIN + "/api/muse/v1/oauth", "resource": ORIGIN + "/api/muse/v1"}).encode()
        with patch.object(client_module.HTTP, "open", return_value=response) as transport:
            result = client_module.public_preflight(ORIGIN)
        self.assertEqual(result["status"], "site_approval_preflight_complete")
        request = transport.call_args.args[0]
        self.assertEqual(request.full_url, ORIGIN + "/api/muse/v1/oauth/metadata")
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertIsNone(request.get_header("Authorization"))
        self.assertIsNone(request.get_header("X-paperclip-muse-binding"))
        self.assertEqual(transport.call_args.kwargs["timeout"], 120)
        self.helper.add_surrogate_to_request.assert_not_called()
        self.helper.read_json_response.assert_not_called()

    def test_approval_timeout_is_bounded_sanitized_and_keeps_original_command_identity(self):
        private = "synthetic-private-header-and-provider-detail"
        command = {"command": "accept", "assignmentId": ASSIGNMENT}
        requests = []
        def unavailable(request, timeout):
            requests.append(request)
            self.assertEqual(timeout, 120)
            raise urllib.error.URLError(TimeoutError(private))
        with patch.object(client_module.HTTP, "open", side_effect=unavailable):
            with self.assertRaisesRegex(RuntimeError, "transport_timeout_or_permission_wait") as failure:
                self.client.command("approval-wait", command)
        self.assertNotIn(private, str(failure.exception))
        journal = json.loads(self.client.journal_path("approval-wait").read_text())
        self.assertEqual(journal["state"], "sending")
        self.assertEqual(len(requests), 1)
        with patch.object(client_module, "http", return_value={"status": "accepted"}) as retry:
            self.client.command("approval-wait", command)
        self.assertEqual(retry.call_args.args[1]["requestId"], journal["command"]["requestId"])
        with patch.object(client_module.HTTP, "open", side_effect=TimeoutError(private)):
            with self.assertRaisesRegex(RuntimeError, "transport_timeout_or_permission_wait"):
                client_module.public_preflight(ORIGIN)

    def test_existing_managed_hook_directory_permissions_are_preserved(self):
        os.chmod(client_module.HOOK_ROOT, 0o755)
        self.client.configure(ORIGIN)
        self.assertEqual(stat.S_IMODE(client_module.HOOK_ROOT.stat().st_mode), 0o755)

    def test_cleanup_cli_returns_authenticated_receipt_without_legacy_suspension_state(self):
        import io
        from contextlib import redirect_stdout
        # The CLI creates its own client,so release this fixture's file lock.
        self.client.close()
        receipt = {"status": "live", "controls": []}
        output = io.StringIO()
        with patch.object(sys, "argv", ["client.py", "--binding", BINDING, "cleanup", "--inspect"]), patch.object(client_module, "http", return_value=receipt) as transport, redirect_stdout(output):
            client_module.main()
        self.assertEqual(json.loads(output.getvalue()), receipt)
        transport.assert_called_once_with(ORIGIN + "/api/muse/v1/cleanup", {"version": 1, "command": "control.inspect"}, CREDENTIAL_NAME)
        self.assertFalse((self.client.directory / "worker.json").exists())

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
            self.assertEqual(calls[1][2], CREDENTIAL_NAME)
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
            self.client.config["generation"] = 2
            client_module.save(self.client.path, self.client.config)
            self.reopen()
            self.client.detector_cleanup(False)
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[1][0]["generation"], 2)
            self.assertEqual(calls[1][1], CREDENTIAL_NAME)
            self.assertNotEqual(calls[0][0]["requestId"], calls[1][0]["requestId"])
            self.client.detector_cleanup(False)
            self.assertEqual(len(calls), 2)

    def test_canonical_answer_is_persisted_before_ingestion_receipt(self):
        response = self.input_response()
        calls = []

        def transport(url, body=None, token=None):
            calls.append(copy.deepcopy(body))
            if body.get("query") == "input.pending":
                return copy.deepcopy(response)
            persisted = json.loads(self.input_path().read_text())
            self.assertEqual(body["continuationReceiptId"], persisted["inputs"]["question-one"]["continuationReceiptId"])
            self.assertTrue(body["continuationPersisted"])
            self.assertEqual(body["inputDigest"], response["inputDigest"])
            return {"status": "consumed", "requestId": body["nativeRequestId"], "inputDigest": body["inputDigest"]}

        with patch.object(client_module, "http", transport):
            answer = self.client.answer(ASSIGNMENT, "question-one")
            self.assertEqual([call.get("command") for call in calls], [None])
            self.reopen()
            self.assertEqual(self.client.answer(ASSIGNMENT, "question-one")["continuationReceiptId"], answer["continuationReceiptId"])
            self.assertEqual(self.client.consume(ASSIGNMENT, "question-one")["status"], "consumed")
            response["inputDigest"] = "sha256:" + "b" * 64
            with self.assertRaisesRegex(RuntimeError, "Input changed"):
                self.client.answer(ASSIGNMENT, "question-one")

    def test_authd_failure_has_no_raw_token_fallback_or_secret_output(self):
        self.helper.add_surrogate_to_request.side_effect = RuntimeError("synthetic-private-surrogate-should-never-print")
        with patch.object(client_module.HTTP, "open") as transport:
            with self.assertRaisesRegex(RuntimeError, "Secure Vault authorization unavailable") as error:
                self.client.query({"query": "identify"})
            self.assertNotIn("synthetic-private-surrogate", str(error.exception))
            transport.assert_not_called()
        self.assertFalse((self.client.directory / "worker.json").exists())
        self.assertFalse((self.client.directory / "credential-commit.json").exists())

    def test_supported_authd_helper_handles_authenticated_io_without_caching_headers(self):
        private_surrogate = "synthetic-private-surrogate-should-never-persist"
        def add(request, **kwargs):
            self.assertEqual(kwargs, {"credential_name": CREDENTIAL_NAME, "entry_name": "access_token", "allowed_hosts": ["paperclip.invalid"]})
            request.add_header("Authorization", "Bearer " + private_surrogate)
        self.helper.add_surrogate_to_request.side_effect = add
        response = Mock(); response.status = 200; response.headers.get_content_type.return_value = "application/json"
        response.read.return_value = json.dumps(identity()).encode(); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=None)
        with patch.object(client_module.HTTP, "open", return_value=response) as transport:
            self.client.status()
            self.assertEqual(transport.call_args[0][0].get_header("Authorization"), "Bearer " + private_surrogate)
            self.assertEqual(self.helper.read_json_response.call_count, 1)
        for path in self.client.directory.rglob("*.json"):
            self.assertNotIn(private_surrogate, path.read_text())
            self.assertNotIn('"Authorization"', path.read_text())

    def test_supported_authd_response_is_bounded_and_errors_are_safe(self):
        response = Mock(); response.status = 200; response.headers.get_content_type.return_value = "application/json"
        response.read.return_value = b"x" * (client_module.MAX_BYTES + 1); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=None)
        with patch.object(client_module.HTTP, "open", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "transport limit"):
                self.client.query({"query": "identify"})
        self.helper.read_json_response.side_effect = RuntimeError("synthetic-private-surrogate-error")
        with patch.object(client_module.HTTP, "open", return_value=response):
            with self.assertRaises(RuntimeError) as error:
                self.client.query({"query": "identify"})
            self.assertNotIn("synthetic-private-surrogate", str(error.exception))

    def test_profile_publication_recovers_without_authentication_or_secret_state(self):
        original_save = client_module.save
        def fail_receiver_publish(path, value):
            if path.name == "receiver.json": raise OSError("Synthetic interruption after profile publication")
            original_save(path, value)
        with patch.object(client_module, "save", fail_receiver_publish):
            with self.assertRaises(OSError): self.client.configure(ORIGIN)
        self.assertTrue((self.client.directory / "connection-commit.json").exists())
        with patch.object(client_module, "http", side_effect=AssertionError("Profile recovery must not authenticate")):
            self.reopen()
            self.assertEqual(self.client.credential_name(), CREDENTIAL_NAME)
        receiver = json.loads((self.client.directory / "receiver.json").read_text())
        self.assertEqual(receiver, {"version": 1, "origin": ORIGIN, "bindingId": BINDING})
        self.assertFalse((self.client.directory / "connection-commit.json").exists())

    def test_old_private_files_are_never_read_and_profile_rejects_secret_fields(self):
        (self.client.directory / "worker.json").write_text("not parseable private old credentials")
        (self.client.directory / "credential-commit.json").write_text("not parseable private old rotation")
        self.reopen()
        self.assertEqual(self.client.credential_name(), CREDENTIAL_NAME)
        value = {**self.client.config, "accessToken": "synthetic-forbidden-token"}
        with self.assertRaisesRegex(RuntimeError, "Unexpected connection profile"): self.client.validate_profile(value)
        with self.assertRaisesRegex(RuntimeError, "generation changed"):
            self.client.remember_identity({**identity(), "generation": 2})

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
        response = self.input_response()
        for field, value in (("assignmentId", BINDING), ("bindingId", ASSIGNMENT), ("generation", 2), ("requestId", "question-two")):
            with self.subTest(field=field), patch.object(client_module, "http", return_value={**response, field: value}):
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                    self.client.answer(ASSIGNMENT, "question-one")
                self.assertFalse((self.client.directory / "input-receipts" / (ASSIGNMENT + ".json")).exists())

    def run_detector(self, response=None, status=200, dry=True, wrapper=False):
        root = Path(self.temporary.name)
        runtime = root / "hook-runtime.sh"
        runtime.write_text('silent() { printf "SILENT:%s\\n" "$1"; }\nwake() { printf "WAKE:%s\\n" "$1"; }\ndisable_after_run() { printf "DISABLE\\n"; }\n')
        # Run the shipped Bash/embedded Python or actual no-argument wrapper.
        # Only temporary HOME and the HTTPS transport are replaced.
        (root / "sitecustomize.py").write_text("""
import json, os
from pathlib import Path
from unittest.mock import Mock
import urllib.request, urllib.error
root = Path(os.environ['MUSE_DETECTOR_TEST_ROOT'])
Path.home = classmethod(lambda cls: root)
class Response:
    status = 200
    headers = Mock()
    headers.get_content_type.return_value = 'application/json'
    def __enter__(self): return self
    def __exit__(self, *args): return None
    def read(self, count): return os.environ['MUSE_DETECTOR_RESPONSE'].encode()
class Opener:
    def open(self, request, timeout):
        with (root / 'requests.jsonl').open('a') as stream:
            stream.write(json.dumps({'url': request.full_url, 'headers': dict(request.header_items())}) + '\\n')
        status = int(os.environ['MUSE_DETECTOR_STATUS'])
        if status != 200: raise urllib.error.HTTPError(request.full_url, status, 'Synthetic unavailable', None, None)
        return Response()
urllib.request.build_opener = lambda *args: Opener()
""")
        (root / "requests.jsonl").unlink(missing_ok=True)
        detector = client_path.with_name('detector.sh')
        if wrapper:
            installed = client_module.ROOT / "detector.sh"
            installed.write_bytes(detector.read_bytes())
            invocation = [str(client_module.HOOK_ROOT / ("paperclip-muse-" + BINDING + ".sh"))]
        else:
            invocation = ['bash', str(detector), BINDING]
        result = subprocess.run(invocation,
            env={**os.environ, 'HOME': str(root), 'PYTHONPATH': str(root), 'PYTHONDONTWRITEBYTECODE': '1',
                 'MUSE_DETECTOR_TEST_ROOT': str(root), 'HATCH_HOOK_RUNTIME': str(runtime),
                 'HATCH_HOOK_DRY_RUN': 'true' if dry else 'false', 'MUSE_DETECTOR_STATUS': str(status),
                 'MUSE_DETECTOR_RESPONSE': json.dumps(response or {'version': 1, 'signal': None})},
            check=True, text=True, capture_output=True, timeout=10)
        requests = root / 'requests.jsonl'
        return result.stdout, [json.loads(line) for line in requests.read_text().splitlines()] if requests.exists() else []

    def assert_public_request(self, requests):
        self.assertEqual(requests, [{'url': ORIGIN + '/api/muse/v1/signal',
            'headers': {'Accept': 'application/json', 'X-paperclip-muse-binding': BINDING}}])

    def test_running_detector_is_independent_of_private_lock_and_worker_credentials(self):
        # The client still holds its exclusive OS lock; it is irrelevant to the
        # public detector, even when every worker/rotation file is unreadable.
        self.client.path.write_text('unreadable synthetic worker credential state')
        for marker in ('signal-suspended.json', 'credential-commit.json'):
            (self.client.directory / marker).write_text('not parseable private worker state')
        output, requests = self.run_detector(wrapper=True)
        self.assertIn('SILENT:No queued work', output)
        self.assertNotIn('WAKE:', output)
        self.assertNotIn('DISABLE', output)
        self.assert_public_request(requests)

    def test_running_detector_retries_transient_failures_without_disabling(self):
        for status in (401, 403, 500, 503):
            with self.subTest(status=status):
                output, requests = self.run_detector(status=status)
                self.assertIn('SILENT:Receiver unavailable; backing off', output)
                self.assertNotIn('WAKE:', output)
                self.assertNotIn('DISABLE', output)
                self.assert_public_request(requests)

    def test_running_detector_disables_on410_without_authenticated_cleanup(self):
        output, requests = self.run_detector(status=410, dry=False, wrapper=True)
        self.assertIn('DISABLE', output)
        self.assertNotIn('WAKE:', output)
        self.assertIn('removal requested', output)
        self.assert_public_request(requests)
        self.assertNotIn('confirmed', output)

    def test_running_detector_wakes_once_per_opaque_reference_and_keeps_idle_silent(self):
        signal = {'version': 1, 'signal': {'reference': 'sha256:' + 'a' * 64}}
        output, requests = self.run_detector(response=signal, dry=False, wrapper=True)
        self.assertIn('WAKE:', output); self.assert_public_request(requests)
        output, requests = self.run_detector(response=signal, dry=False, wrapper=True)
        self.assertIn('Signal already observed', output); self.assertNotIn('WAKE:', output)
        self.assert_public_request(requests)
        output, requests = self.run_detector(response={'version': 1, 'signal': {'reference': 'sha256:' + 'b' * 64}}, dry=False)
        self.assertIn('WAKE:', output); self.assert_public_request(requests)
        output, requests = self.run_detector(dry=False)
        self.assertIn('SILENT:No queued work', output); self.assertNotIn('WAKE:', output)
        self.assert_public_request(requests)

    def assert_receiver_sequence(self, responses):
        self.assertEqual(len(responses), 6)
        offered_a, idle_a, offered_b, duplicate_b, rearmed_b, claimed_b = responses
        self.assertEqual(idle_a, {"version": 1, "signal": None})
        self.assertEqual(claimed_b, {"version": 1, "signal": None})
        self.assertEqual(duplicate_b, offered_b)
        references = [value["signal"]["reference"] for value in (offered_a, offered_b, rearmed_b)]
        self.assertEqual(len(set(references)), 3)
        marker = Path(self.temporary.name) / "hooks/state" / ("paperclip-" + BINDING) / "signal"
        expected_markers = [references[0], references[0], references[1], references[1], references[2], references[2]]
        for response, expected, expected_marker in zip(responses, ("wake", "idle", "wake", "duplicate", "wake", "idle"), expected_markers):
            output, requests = self.run_detector(response=response, dry=False, wrapper=True)
            self.assert_public_request(requests)
            self.assertNotIn("DISABLE", output)
            self.assertNotIn("Receiver unavailable", output)
            if expected == "wake":
                self.assertIn("WAKE:PAPERCLIP_MUSE:", output)
                self.assertIn("binding " + BINDING, output)
            else:
                self.assertNotIn("WAKE:", output)
                self.assertIn("Signal already observed" if expected == "duplicate" else "No queued work", output)
            self.assertEqual(marker.read_text().strip(), expected_marker)

    def test_running_detector_rejects_legacy_reference_and_extra_receiver_fields(self):
        output, requests = self.run_detector(response={'version': 1, 'signal': {'reference': BINDING + ':1:1:1'}})
        self.assertIn('backing off', output); self.assertNotIn('WAKE:', output)
        self.assert_public_request(requests)
        receiver = self.client.directory / "receiver.json"
        value = json.loads(receiver.read_text()); value['accessToken'] = 'unexpected-private-field'; receiver.write_text(json.dumps(value))
        output, requests = self.run_detector()
        self.assertIn('backing off', output); self.assertEqual(requests, [])

    def test_http_errors_do_not_echo_url_or_credentials(self):
        sensitive_url = ORIGIN + "/api/muse/v1/queries"
        error = urllib.error.HTTPError(sensitive_url, 401, "synthetic-private-provider-detail", {}, None)
        with patch.object(client_module.HTTP, "open", side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                client_module.http(sensitive_url, {"query": "identify"}, CREDENTIAL_NAME)
            self.assertEqual(str(raised.exception), "Paperclip HTTP 401; inspect connection or receipt before retrying")
        error.close()

    def test_redirects_and_non_https_origins_are_rejected(self):
        for origin in ("http://paperclip.invalid", "https://user:secret@paperclip.invalid", "https://paperclip.invalid/path", "https://paperclip.invalid/?secret=x"):
            with self.assertRaises(RuntimeError):
                client_module.origin(origin)
        self.assertIsNone(client_module.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://elsewhere.invalid"))

    def input_response(self, **changes):
        value = {"assignmentId": ASSIGNMENT, "bindingId": BINDING, "generation": 1,
                 "requestId": "question-one", "turnId": "turn-one",
                 "response": {"schema": "paperclip.question_response.v1", "answers": {"format": {"text": "Markdown"}}}, "consumed": False}
        value["inputDigest"] = "sha256:" + client_module.hashlib.sha256(client_module.canonical({k: value[k] for k in ("requestId", "turnId", "response")})).hexdigest()
        return {**value, **changes}

    def selected_input(self, count, request="question-one"):
        response = {"schema": "paperclip.question_response.v1", "answers": {
            "choices": {"selectedOptionIds": ["choice-" + str(index) for index in range(count)]},
            "format": {"text": "Markdown"}}}
        value = self.input_response(response=response, requestId=request)
        value["inputDigest"] = "sha256:" + client_module.hashlib.sha256(client_module.canonical({key: value[key] for key in ("requestId", "turnId", "response")})).hexdigest()
        return value

    def test_supported_multi_select_boundaries_are_persisted_and_consumed(self):
        for count in (64, 65, 128):
            with self.subTest(count=count):
                request = "choices-" + str(count)
                value = self.selected_input(count, request)
                commands = []
                def transport(url, body=None, token=None):
                    if body.get("query"): return value
                    commands.append(copy.deepcopy(body))
                    return {"status": "consumed", "requestId": request, "inputDigest": value["inputDigest"]}
                with patch.object(client_module, "http", transport):
                    answer = self.client.answer(ASSIGNMENT, request)
                    self.client.consume(ASSIGNMENT, request)
                saved = json.loads(self.input_path(request).read_text())["inputs"][request]
                self.assertEqual(saved["response"], value["response"])
                self.assertEqual(len(saved["response"]["answers"]["choices"]["selectedOptionIds"]), count)
                self.assertEqual(saved["response"]["answers"]["format"], {"text": "Markdown"})
                self.assertEqual(len(commands), 1)
                self.assertEqual(commands[0]["continuationReceiptId"], answer["continuationReceiptId"])
                self.assertEqual(commands[0]["inputDigest"], value["inputDigest"])

    def test_over_bound_and_duplicate_selections_fail_before_receipt_or_consume(self):
        values = [self.selected_input(129), self.selected_input(2)]
        values[1]["response"]["answers"]["choices"]["selectedOptionIds"] = ["choice-0", "choice-0"]
        for value in values:
            with self.subTest(selected=value["response"]["answers"]["choices"]["selectedOptionIds"]):
                with patch.object(client_module, "http", return_value=value) as transport:
                    with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                        self.client.answer(ASSIGNMENT, "question-one")
                    self.assertFalse(any(call.args[1].get("command") for call in transport.call_args_list))
                self.assertFalse(self.input_path().exists())
                self.assertFalse(self.client.journal_path("consume:" + ASSIGNMENT + ":question-one").exists())

    def test_selection_cap_does_not_widen_question_or_option_id_bounds(self):
        response = {"schema": "paperclip.question_response.v1", "answers": {
            "question-" + str(index): {"selectedOptionIds": ["x" * 160]} for index in range(64)}}
        self.assertTrue(client_module.input_response_valid(response))
        response["answers"]["question-64"] = {"selectedOptionIds": ["x"]}
        self.assertFalse(client_module.input_response_valid(response))
        response["answers"].pop("question-64")
        response["answers"]["question-0"] = {"selectedOptionIds": ["x" * 161]}
        self.assertFalse(client_module.input_response_valid(response))

    def test_128_selections_survive_lost_consume_response_with_original_identity(self):
        value = self.selected_input(128)
        commands = []
        def transport(url, body=None, token=None):
            if body.get("query"): return {**value, "consumed": bool(commands)}
            commands.append(copy.deepcopy(body))
            if len(commands) == 1: raise RuntimeError("Synthetic consume response lost")
            return {"status": "consumed", "requestId": value["requestId"], "inputDigest": value["inputDigest"]}
        with patch.object(client_module, "http", transport):
            answer = self.client.answer(ASSIGNMENT, "question-one")
            with self.assertRaisesRegex(RuntimeError, "response lost"):
                self.client.consume(ASSIGNMENT, "question-one")
            self.reopen()
            recovered = self.client.answer(ASSIGNMENT, "question-one")
            self.assertEqual(recovered["continuationReceiptId"], answer["continuationReceiptId"])
            self.client.consume(ASSIGNMENT, "question-one")
            self.client.consume(ASSIGNMENT, "question-one")
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0], commands[1])
        self.assertEqual(commands[0]["inputDigest"], value["inputDigest"])

    def input_record(self, value=None):
        value = value or {**self.input_response(), "continuationReceiptId": "50000000-0000-4000-8000-000000000001"}
        return {"schema": "paperclip.muse_input_receipts.v2", "bindingId": BINDING, "generation": 1,
                "assignmentId": ASSIGNMENT, "inputs": {"question-one": value}}

    def input_path(self, request="question-one"):
        return self.client.input_receipt_path(ASSIGNMENT, request)

    def aggregate_input_path(self):
        return self.client.directory / "input-receipts" / (ASSIGNMENT + ".json")

    def aggregate_record(self, inputs):
        return {"schema": "paperclip.muse_input_receipts.v1", "bindingId": BINDING, "generation": 1, "assignmentId": ASSIGNMENT, "inputs": inputs}

    def legacy_input_path(self):
        return self.client.directory / "continuations" / (ASSIGNMENT + ".json")

    def test_model_work_state_is_preserved_without_an_inputs_map(self):
        models = [{"phase": "waiting", "taskState": {"memo": "synthetic work"}},
                  {"inputs": None, "phase": "waiting"}, {"inputs": [], "phase": "waiting"},
                  None, [], "not parseable JSON"]
        for model in models:
            with self.subTest(model=model):
                if self.input_path().exists(): self.input_path().unlink()
                legacy = self.legacy_input_path(); legacy.parent.mkdir(exist_ok=True)
                original = json.dumps(model) if model != "not parseable JSON" else model
                legacy.write_text(original)
                work = self.client.directory / "work-continuations" / (ASSIGNMENT + ".json")
                client_module.save(work, {"schema": "paperclip.muse_work_continuation.v1", "phase": "waiting"})
                work_bytes = work.read_bytes()
                with patch.object(client_module, "http", return_value=self.input_response()) as transport:
                    result = self.client.answer(ASSIGNMENT, "question-one")
                self.assertEqual(result["response"], self.input_response()["response"])
                self.assertEqual(legacy.read_text(), original)
                self.assertEqual(work.read_bytes(), work_bytes)
                self.assertEqual(json.loads(self.input_path().read_text())["schema"], "paperclip.muse_input_receipts.v2")
                self.assertEqual(transport.call_count, 1)

    def test_valid_legacy_prepared_consume_migrates_without_changing_any_identity(self):
        row = self.input_record()["inputs"]["question-one"]
        legacy = {"assignmentId": ASSIGNMENT, "inputs": {"question-one": row}}
        client_module.save(self.legacy_input_path(), legacy); original = self.legacy_input_path().read_bytes()
        body = {"version": 1, "command": "consume_input", "assignmentId": ASSIGNMENT,
                "nativeRequestId": "question-one", "inputDigest": row["inputDigest"],
                "continuationReceiptId": row["continuationReceiptId"], "continuationPersisted": True,
                "requestId": "60000000-0000-4000-8000-000000000001"}
        journal = {"command": body, "digest": client_module.hashlib.sha256(client_module.canonical({k:v for k,v in body.items() if k != "requestId"})).hexdigest(), "state": "prepared"}
        key = "consume:" + ASSIGNMENT + ":question-one"
        client_module.save(self.client.journal_path(key), journal); prepared = self.client.journal_path(key).read_bytes()
        commands = []
        def transport(url, body=None, token=None):
            if body.get("query"): return self.input_response()
            commands.append(copy.deepcopy(body)); return {"status": "consumed", "requestId": body["nativeRequestId"], "inputDigest": body["inputDigest"]}
        with patch.object(client_module, "http", transport):
            answer = self.client.answer(ASSIGNMENT, "question-one")
            self.assertEqual(answer["continuationReceiptId"], row["continuationReceiptId"])
            self.assertEqual(self.client.journal_path(key).read_bytes(), prepared)
            self.reopen(); self.client.consume(ASSIGNMENT, "question-one")
        self.assertEqual(commands, [body])
        self.assertEqual(self.legacy_input_path().read_bytes(), original)
        self.assertEqual(json.loads(self.input_path().read_text())["inputs"]["question-one"], row)

    def test_malformed_current_receipts_fail_closed_and_do_not_echo_private_values(self):
        valid = self.input_record()
        cases = [None, [], {**valid, "inputs": None}, {**valid, "inputs": []}, {**valid, "generation": True},
                 {**valid, "assignmentId": BINDING}, {**valid, "synthetic-private-key": "synthetic-private-value"},
                 {**valid, "inputs": {"invalid/request": valid["inputs"]["question-one"]}},
                 {**valid, "inputs": {"question-one": None}}]
        row = valid["inputs"]["question-one"]
        for change in ({"turnId": None}, {"turnId": "\ud800"}, {"inputDigest": None}, {"response": []}, {"consumed": 1},
                       {"generation": True}, {"requestId": "other"}, {"continuationReceiptId": "not-a-uuid"},
                       {"synthetic-private-field": "synthetic-private-answer"}):
            cases.append(self.input_record({**row, **change}))
        for record in cases:
            with self.subTest(record=record):
                self.input_path().parent.mkdir(parents=True, exist_ok=True)
                self.input_path().write_text(json.dumps(record)); original = self.input_path().read_bytes()
                with patch.object(client_module, "http", return_value=self.input_response()) as transport:
                    for action in (self.client.answer, self.client.consume):
                        with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid") as failure:
                            action(ASSIGNMENT, "question-one")
                        self.assertNotIn("synthetic-private", str(failure.exception))
                    self.assertFalse(any(call.args[1].get("command") for call in transport.call_args_list))
                self.assertEqual(self.input_path().read_bytes(), original)
                self.assertFalse(self.client.journal_path("consume:" + ASSIGNMENT + ":question-one").exists())

    def test_duplicate_json_keys_are_not_silently_adopted_as_a_helper_receipt(self):
        self.input_path().parent.mkdir(parents=True, exist_ok=True)
        self.input_path().write_text('{"schema":"paperclip.muse_input_receipts.v2","inputs":{},"inputs":null}')
        with patch.object(client_module, "http") as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                self.client.consume(ASSIGNMENT, "question-one")
            transport.assert_not_called()

    def test_missing_or_invalid_native_answer_fields_never_prepare_a_consume(self):
        for change in ({"turnId": None}, {"turnId": ""}, {"inputDigest": None}, {"inputDigest": ""},
                       {"response": {"answers": {}}}, {"generation": True},
                       {"response": {"schema": "paperclip.question_response.v1", "answers": {"format": {"text": 1}}}},
                       {"response": {"schema": "paperclip.question_response.v1", "answers": {"format": {"text": "\ud800"}}}},
                       {"response": {"schema": "paperclip.question_response.v1", "answers": {"format": {"selectedOptionIds": ["x", "x"]}}}}):
            with self.subTest(change=change), patch.object(client_module, "http", return_value=self.input_response(**change)):
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                    self.client.answer(ASSIGNMENT, "question-one")
                self.assertFalse(self.input_path().exists())
                self.assertFalse(self.client.journal_path("consume:" + ASSIGNMENT + ":question-one").exists())

    def test_ambiguous_legacy_helper_receipts_are_never_replaced_with_new_identities(self):
        row = self.input_record()["inputs"]["question-one"]
        for record in ({"assignmentId": BINDING, "inputs": {"question-one": row}},
                       {"assignmentId": ASSIGNMENT, "inputs": {"question-one": {**row, "turnId": None}}},
                       {"assignmentId": ASSIGNMENT, "inputs": {"question-one": row}, "modelState": {}},
                       {"assignmentId": ASSIGNMENT, "inputs": {"question-one": {**row, "continuationReceiptId": None}}}):
            client_module.save(self.legacy_input_path(), record); original = self.legacy_input_path().read_bytes()
            with patch.object(client_module, "http", return_value=self.input_response()) as transport:
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                    self.client.answer(ASSIGNMENT, "question-one")
                self.assertFalse(any(call.args[1].get("command") for call in transport.call_args_list))
            self.assertEqual(self.legacy_input_path().read_bytes(), original)
            self.assertFalse(self.input_path().exists())

    def test_input_consume_lost_response_and_duplicate_reuse_exact_prepared_command(self):
        commands = []
        def transport(url, body=None, token=None):
            if body.get("query"): return self.input_response(consumed=bool(commands))
            commands.append(copy.deepcopy(body))
            if len(commands) == 1: raise RuntimeError("Synthetic consume response lost")
            return {"status": "consumed", "requestId": body["nativeRequestId"], "inputDigest": body["inputDigest"]}
        with patch.object(client_module, "http", transport):
            answer = self.client.answer(ASSIGNMENT, "question-one")
            with self.assertRaisesRegex(RuntimeError, "response lost"):
                self.client.consume(ASSIGNMENT, "question-one")
            self.reopen()
            self.assertEqual(self.client.answer(ASSIGNMENT, "question-one")["continuationReceiptId"], answer["continuationReceiptId"])
            self.client.consume(ASSIGNMENT, "question-one")
            self.client.consume(ASSIGNMENT, "question-one")
        self.assertEqual(len(commands), 2); self.assertEqual(commands[0], commands[1])

    def test_prepared_consume_can_recover_its_receipt_but_unknown_effect_cannot_replay(self):
        row = self.input_record()["inputs"]["question-one"]
        body = {"command": "consume_input", "assignmentId": ASSIGNMENT, "nativeRequestId": "question-one",
                "inputDigest": row["inputDigest"], "continuationReceiptId": row["continuationReceiptId"], "continuationPersisted": True}
        key = "consume:" + ASSIGNMENT + ":question-one"
        with patch.object(client_module, "http", side_effect=RuntimeError("Synthetic lost ACK")):
            with self.assertRaises(RuntimeError): self.client.command(key, body)
        prepared = self.client.journal_path(key).read_bytes()
        client_module.save(self.legacy_input_path(), {"phase": "waiting"})
        with patch.object(client_module, "http", return_value=self.input_response(consumed=True)):
            result = self.client.answer(ASSIGNMENT, "question-one")
        self.assertEqual(result["continuationReceiptId"], row["continuationReceiptId"])
        self.assertEqual(self.client.journal_path(key).read_bytes(), prepared)
        journal = json.loads(prepared); journal["receipt"] = {"status": "unknown", "canReplay": False}
        client_module.save(self.client.journal_path(key), journal)
        with patch.object(client_module, "http", return_value=self.input_response(consumed=True)) as transport:
            with self.assertRaisesRegex(RuntimeError, "unresolved"):
                self.client.consume(ASSIGNMENT, "question-one")
            self.assertFalse(any(call.args[1].get("command") for call in transport.call_args_list))

    def test_consumed_response_without_local_original_receipt_fails_closed(self):
        with patch.object(client_module, "http", return_value=self.input_response(consumed=True)):
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                self.client.answer(ASSIGNMENT, "question-one")
        self.assertFalse(self.input_path().exists())

    def test_conflicting_prepared_consume_identity_cannot_replace_a_receipt(self):
        row = self.input_record()["inputs"]["question-one"]
        client_module.save(self.input_path(), self.input_record())
        body = {"command": "consume_input", "assignmentId": ASSIGNMENT, "nativeRequestId": "question-one",
                "inputDigest": row["inputDigest"], "continuationReceiptId": "50000000-0000-4000-8000-000000000002", "continuationPersisted": True}
        key = "consume:" + ASSIGNMENT + ":question-one"
        with patch.object(client_module, "http", side_effect=RuntimeError("Synthetic lost ACK")):
            with self.assertRaises(RuntimeError): self.client.command(key, body)
        original = self.client.journal_path(key).read_bytes()
        with patch.object(client_module, "http", return_value=self.input_response()) as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                self.client.consume(ASSIGNMENT, "question-one")
            self.assertFalse(any(call.args[1].get("command") for call in transport.call_args_list))
        self.assertEqual(self.client.journal_path(key).read_bytes(), original)

    def test_current_receipt_failure_is_categorical_at_the_cli_boundary(self):
        client_module.save(self.input_path(), {"inputs": {"synthetic-private-question": "synthetic-private-answer"}})
        harness = ('import importlib.util, pathlib, sys; sys.dont_write_bytecode=True; '
                   's=importlib.util.spec_from_file_location("client",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); '
                   'm.ROOT=pathlib.Path(sys.argv[2]); sys.argv=["client.py","--binding",sys.argv[3],"consume-input",sys.argv[4],"question-one"]; '
                   '\ntry: m.main()\nexcept Exception as error:\n print("Paperclip client stopped: "+(str(error) if isinstance(error, RuntimeError) else "private state or transport failure"),file=sys.stderr); sys.exit(1)')
        self.client.close()
        result = subprocess.run([sys.executable, "-c", harness, str(client_path), str(client_module.ROOT), BINDING, ASSIGNMENT], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1); self.assertEqual(result.stdout, "")
        self.assertIn("input_receipt_invalid", result.stderr)
        self.assertNotIn("synthetic-private", result.stderr)


    def test_consumed_answer_without_original_consume_command_does_not_allocate_a_new_one(self):
        client_module.save(self.input_path(), self.input_record())
        with patch.object(client_module, "http", return_value=self.input_response(consumed=True)) as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                self.client.consume(ASSIGNMENT, "question-one")
            self.assertFalse(any(call.args[1].get("command") for call in transport.call_args_list))
        self.assertFalse(self.client.journal_path("consume:" + ASSIGNMENT + ":question-one").exists())

    def test_malformed_prepared_consume_records_do_not_dispatch_or_replace_identity(self):
        row = self.input_record()["inputs"]["question-one"]
        client_module.save(self.input_path(), self.input_record())
        key = "consume:" + ASSIGNMENT + ":question-one"
        body = {"version": 1, "command": "consume_input", "assignmentId": ASSIGNMENT, "nativeRequestId": "question-one",
                "inputDigest": row["inputDigest"], "continuationReceiptId": row["continuationReceiptId"], "continuationPersisted": True,
                "requestId": "60000000-0000-4000-8000-000000000001"}
        journal = {"command": body, "digest": client_module.hashlib.sha256(client_module.canonical({k:v for k,v in body.items() if k != "requestId"})).hexdigest(), "state": "prepared"}
        cases = [None, [], {**journal, "command": None}, {**journal, "state": []}, {**journal, "receipt": {"status": "not-understood"}},
                 {**journal, "receipt": None},
                 {**journal, "receipt": {"status": "consumed", "requestId": body["requestId"], "inputDigest": row["inputDigest"]}},
                 {**journal, "receipt": {"status": "consumed", "requestId": "question-one", "inputDigest": "sha256:" + "b" * 64}},
                 {**journal, "receipt": {"status": "consumed"}}, {**journal, "digest": "synthetic-private-value"}, {**journal, "synthetic-private-key": True}]
        for change in ({"requestId": None}, {"continuationPersisted": 1}, {"inputDigest": "sha256:" + "b" * 64},
                       {"synthetic-private-field": "synthetic-private-value"}):
            cases.append({**journal, "command": {**body, **change}})
        for value in cases:
            with self.subTest(value=value):
                client_module.save(self.client.journal_path(key), value); original = self.client.journal_path(key).read_bytes()
                with patch.object(client_module, "http", return_value=self.input_response()) as transport:
                    with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid") as failure:
                        self.client.consume(ASSIGNMENT, "question-one")
                    self.assertNotIn("synthetic-private", str(failure.exception))
                    transport.assert_not_called()
                self.assertEqual(self.client.journal_path(key).read_bytes(), original)

    def test_input_paths_and_request_keys_reject_traversal_before_transport(self):
        for assignment, request in (("../other", "question-one"), (ASSIGNMENT, "../other"), (ASSIGNMENT, "x" * 161)):
            with patch.object(client_module, "http") as transport:
                for action in (self.client.answer, self.client.consume):
                    with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                        action(assignment, request)
                transport.assert_not_called()

    def test_consume_missing_receipt_and_missing_native_fields_are_not_native_effects(self):
        with patch.object(client_module, "http") as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_missing"):
                self.client.consume(ASSIGNMENT, "question-one")
            transport.assert_not_called()
        for field in ("turnId", "inputDigest"):
            response = self.input_response(); del response[field]
            with patch.object(client_module, "http", return_value=response) as transport:
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                    self.client.answer(ASSIGNMENT, "question-one")
                self.assertEqual(transport.call_count, 1)
            self.assertFalse(self.input_path().exists())


    def test_duplicate_legacy_helper_keys_fail_closed_even_if_last_inputs_value_is_null(self):
        row = self.input_record()["inputs"]["question-one"]
        self.legacy_input_path().parent.mkdir(exist_ok=True)
        content = '{"assignmentId":' + json.dumps(ASSIGNMENT) + ',"inputs":' + json.dumps({"question-one": row}) + ',"inputs":null}'
        self.legacy_input_path().write_text(content)
        with patch.object(client_module, "http") as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                self.client.answer(ASSIGNMENT, "question-one")
            transport.assert_not_called()
        self.assertFalse(self.input_path().exists())
        self.assertEqual(self.legacy_input_path().read_text(), content)

    def test_unreadable_legacy_state_is_not_evidence_for_a_new_receipt(self):
        client_module.save(self.legacy_input_path(), {"assignmentId": ASSIGNMENT, "inputs": self.input_record()["inputs"]})
        original = Path.open
        def blocked(path, *args, **kwargs):
            if path == self.legacy_input_path(): raise PermissionError("synthetic-private-read-failure")
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", blocked), patch.object(client_module, "http") as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid") as failure:
                self.client.answer(ASSIGNMENT, "question-one")
            transport.assert_not_called(); self.assertNotIn("synthetic-private", str(failure.exception))
        self.assertFalse(self.input_path().exists())


    def test_damaged_legacy_helper_envelopes_remain_ambiguous_without_a_new_identity(self):
        self.legacy_input_path().parent.mkdir(exist_ok=True)
        row = self.input_record()["inputs"]["question-one"]
        for content in (json.dumps({"assignmentId": ASSIGNMENT, "inputs": {"question-one": row}}) + " trailing-data",
                        '{"assignmentId":' + json.dumps(ASSIGNMENT) + ',"inputs":'):
            self.legacy_input_path().write_text(content)
            with patch.object(client_module, "http") as transport:
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"):
                    self.client.answer(ASSIGNMENT, "question-one")
                transport.assert_not_called()
            self.assertEqual(self.legacy_input_path().read_text(), content)
            self.assertFalse(self.input_path().exists())

    def test_failed_legacy_publication_retries_with_the_same_receipt_id(self):
        record = self.input_record()
        client_module.save(self.legacy_input_path(), {"assignmentId": ASSIGNMENT, "inputs": record["inputs"]})
        original = self.legacy_input_path().read_bytes()
        save = client_module.save
        def interrupted(path, value):
            if path == self.input_path(): raise OSError("Synthetic interrupted receipt publication")
            return save(path, value)
        with patch.object(client_module, "save", interrupted), patch.object(client_module, "http") as transport:
            with self.assertRaises(OSError): self.client.answer(ASSIGNMENT, "question-one")
            transport.assert_not_called()
        self.reopen()
        with patch.object(client_module, "http", return_value=self.input_response()):
            result = self.client.answer(ASSIGNMENT, "question-one")
        self.assertEqual(result["continuationReceiptId"], record["inputs"]["question-one"]["continuationReceiptId"])
        self.assertEqual(self.legacy_input_path().read_bytes(), original)

    def large_input(self, request, size=100000):
        value = self.input_response(requestId=request, response={"schema": "paperclip.question_response.v1", "answers": {"answer": {"text": "x" * size}}})
        value["inputDigest"] = "sha256:" + client_module.hashlib.sha256(client_module.canonical({key: value[key] for key in ("requestId", "turnId", "response")})).hexdigest()
        return value

    def historical_rows(self, count=3, size=100000):
        import uuid
        return {"question-" + str(index): {**self.large_input("question-" + str(index), size),
            "continuationReceiptId": str(uuid.uuid5(uuid.UUID(BINDING), "question-" + str(index)))} for index in range(1, count + 1)}

    def prepared_input_command(self, row):
        body = {**self.client.consume_body(row), "requestId": "60000000-0000-4000-8000-000000000001"}
        key = "consume:" + ASSIGNMENT + ":" + row["requestId"]
        journal = {"command": body, "digest": client_module.hashlib.sha256(client_module.canonical({k:v for k,v in body.items() if k != "requestId"})).hexdigest(), "state": "prepared"}
        client_module.save(self.client.journal_path(key), journal)
        return body, key

    def test_many_large_answers_use_independent_bounded_files_across_restarts(self):
        commands = []; consumed = set()
        def transport(url, body=None, token=None):
            if body.get("query"): return {**self.large_input(body["nativeRequestId"]), "consumed": body["nativeRequestId"] in consumed}
            commands.append(copy.deepcopy(body)); consumed.add(body["nativeRequestId"])
            return {"status": "consumed", "requestId": body["nativeRequestId"], "inputDigest": body["inputDigest"]}
        with patch.object(client_module, "http", transport):
            for index in range(1, 26):
                request = "question-" + str(index)
                answer = self.client.answer(ASSIGNMENT, request)
                self.client.consume(ASSIGNMENT, request)
                self.assertEqual(json.loads(self.input_path(request).read_text())["inputs"][request]["continuationReceiptId"], answer["continuationReceiptId"])
                self.assertLessEqual(self.input_path(request).stat().st_size, client_module.MAX_INPUT_RECEIPT_BYTES)
                if index % 5 == 0: self.reopen()
        self.assertEqual(len(commands), 25)
        self.assertEqual(len({body["requestId"] for body in commands}), 25)
        self.assertFalse(self.aggregate_input_path().exists())
        self.assertEqual(len(list(self.input_path().parent.glob("*.json"))), 25)
        self.assertTrue(all(len(path.stem) == 64 for path in self.input_path().parent.glob("*.json")))

    def test_oversized_old_aggregate_migrates_and_lost_ack_keeps_prepared_identity(self):
        rows = self.historical_rows(20)
        client_module.save(self.aggregate_input_path(), self.aggregate_record(rows))
        original = self.aggregate_input_path().read_bytes()
        self.assertGreater(len(original), client_module.MAX_BYTES)
        self.assertLessEqual(len(original), client_module.MAX_LEGACY_INPUT_RECEIPTS_BYTES)
        row = rows["question-20"]; body, key = self.prepared_input_command(row)
        prepared = self.client.journal_path(key).read_bytes(); commands = []
        def transport(url, request=None, token=None):
            if request.get("query"): return {**{k:v for k,v in row.items() if k != "continuationReceiptId"}, "consumed": bool(commands)}
            commands.append(copy.deepcopy(request))
            if len(commands) == 1: raise RuntimeError("Synthetic consume response lost")
            return {"status": "consumed", "requestId": row["requestId"], "inputDigest": row["inputDigest"]}
        with patch.object(client_module, "http", transport):
            answer = self.client.answer(ASSIGNMENT, row["requestId"])
            self.assertEqual(answer["continuationReceiptId"], row["continuationReceiptId"])
            self.assertEqual(self.client.journal_path(key).read_bytes(), prepared)
            with self.assertRaisesRegex(RuntimeError, "response lost"): self.client.consume(ASSIGNMENT, row["requestId"])
            self.reopen(); self.client.answer(ASSIGNMENT, row["requestId"])
            self.client.consume(ASSIGNMENT, row["requestId"]); self.client.consume(ASSIGNMENT, row["requestId"])
        self.assertEqual(commands, [body, body]); self.assertEqual(self.aggregate_input_path().read_bytes(), original)
        for request, old in rows.items():
            saved = json.loads(self.input_path(request).read_text())["inputs"][request]
            self.assertEqual({k:v for k,v in saved.items() if k != "consumed"}, {k:v for k,v in old.items() if k != "consumed"})

    def test_partial_migration_crash_retries_exact_targets_before_any_transport(self):
        rows = self.historical_rows(); client_module.save(self.aggregate_input_path(), self.aggregate_record(rows))
        original = self.aggregate_input_path().read_bytes(); save = client_module.save
        def interrupted(path, value):
            if path == self.input_path("question-2"): raise OSError("Synthetic interrupted migration")
            return save(path, value)
        with patch.object(client_module, "save", interrupted), patch.object(client_module, "http") as transport:
            with self.assertRaises(OSError): self.client.answer(ASSIGNMENT, "question-3")
            transport.assert_not_called()
        first = self.input_path("question-1").read_bytes(); self.assertFalse((self.input_path().parent / "migration.json").exists())
        self.reopen()
        value = {k:v for k,v in rows["question-3"].items() if k != "continuationReceiptId"}
        with patch.object(client_module, "http", return_value=value), patch.object(client_module.uuid, "uuid4", side_effect=AssertionError("Migration must not allocate an identity")):
            answer = self.client.answer(ASSIGNMENT, "question-3")
        self.assertEqual(answer["continuationReceiptId"], rows["question-3"]["continuationReceiptId"])
        self.assertEqual(self.input_path("question-1").read_bytes(), first); self.assertEqual(self.aggregate_input_path().read_bytes(), original)
        self.assertTrue((self.input_path().parent / "migration.json").exists())

    def test_conflicting_partial_target_fails_before_publishing_other_receipts(self):
        rows = self.historical_rows(); client_module.save(self.aggregate_input_path(), self.aggregate_record(rows))
        conflicting = {**rows["question-2"], "continuationReceiptId": "50000000-0000-4000-8000-000000000002"}
        client_module.save(self.input_path("question-2"), self.client.input_envelope(ASSIGNMENT, {"question-2": conflicting}))
        original = self.input_path("question-2").read_bytes()
        with patch.object(client_module, "http") as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"): self.client.answer(ASSIGNMENT, "question-3")
            transport.assert_not_called()
        self.assertEqual(self.input_path("question-2").read_bytes(), original)
        self.assertFalse(self.input_path("question-1").exists()); self.assertFalse(self.input_path("question-3").exists())
        self.assertFalse((self.input_path().parent / "migration.json").exists())

    def test_historical_and_individual_read_bounds_fail_closed_without_echoing_values(self):
        for path, maximum in ((self.aggregate_input_path(), client_module.MAX_LEGACY_INPUT_RECEIPTS_BYTES), (self.input_path(), client_module.MAX_INPUT_RECEIPT_BYTES)):
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b" " * (maximum + 1))
            with patch.object(client_module, "http") as transport:
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid") as error: self.client.answer(ASSIGNMENT, "question-one")
                self.assertNotIn(str(path), str(error.exception)); transport.assert_not_called()
            self.assertEqual(path.stat().st_size, maximum + 1); path.unlink()

    def test_malformed_or_duplicate_aggregate_is_never_partially_migrated(self):
        rows = self.historical_rows(2); valid = self.aggregate_record(rows)
        invalid = [json.dumps({**valid, "unexpected": "synthetic-private-value"}),
                   json.dumps({**valid, "generation": True}),
                   json.dumps(self.aggregate_record({**rows, "question-2": {**rows["question-2"], "turnId": None}})),
                   json.dumps(valid)[:-1] + ',"inputs":{} }']
        for content in invalid:
            self.aggregate_input_path().parent.mkdir(exist_ok=True); self.aggregate_input_path().write_text(content)
            with patch.object(client_module, "http") as transport:
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid") as error: self.client.answer(ASSIGNMENT, "question-1")
                self.assertNotIn("synthetic-private", str(error.exception)); transport.assert_not_called()
            self.assertEqual(self.aggregate_input_path().read_text(), content)
            self.assertFalse(self.input_path("question-1").exists()); self.assertFalse((self.input_path().parent / "migration.json").exists())

    def near_transport_input(self, unit):
        value = self.input_response(response={"schema": "paperclip.question_response.v1", "answers": {"answer-" + str(index): {"text": ""} for index in range(64)}})
        remaining = client_module.MAX_BYTES - len(client_module.canonical(value))
        unit_bytes = len(client_module.canonical(unit)) - 2
        for answer in value["response"]["answers"].values():
            count = min(remaining // unit_bytes, 100000 // len(unit))
            answer["text"] = unit * count; remaining -= count * unit_bytes
            if remaining < unit_bytes and len(answer["text"]) + remaining <= 100000:
                answer["text"] += "a" * remaining; remaining = 0; break
        self.assertEqual(remaining, 0)
        value["inputDigest"] = "sha256:" + client_module.hashlib.sha256(client_module.canonical({key: value[key] for key in ("requestId", "turnId", "response")})).hexdigest()
        self.assertEqual(len(client_module.canonical(value)), client_module.MAX_BYTES)
        return value

    def test_ascii_and_utf8_escaped_near_transport_answers_remain_readable_after_save(self):
        for unit in ("a", "答😀\n\"\\\t"):
            with self.subTest(unit=unit):
                if self.input_path().exists(): self.input_path().unlink()
                key = "consume:" + ASSIGNMENT + ":question-one"
                if self.client.journal_path(key).exists(): self.client.journal_path(key).unlink()
                value = self.near_transport_input(unit)
                def transport(url, body=None, token=None):
                    if body.get("query"): return value
                    return {"status": "consumed", "requestId": value["requestId"], "inputDigest": value["inputDigest"]}
                with patch.object(client_module, "http", transport):
                    answer = self.client.answer(ASSIGNMENT, "question-one")
                    self.assertGreater(self.input_path().stat().st_size, client_module.MAX_BYTES)
                    self.assertLessEqual(self.input_path().stat().st_size, client_module.MAX_INPUT_RECEIPT_BYTES)
                    self.reopen(); self.assertEqual(self.client.consume(ASSIGNMENT, "question-one")["status"], "consumed")
                self.assertEqual(json.loads(self.input_path().read_text())["inputs"]["question-one"]["continuationReceiptId"], answer["continuationReceiptId"])

    def test_current_writer_rejects_an_unreadable_record_before_publication(self):
        value = self.input_response(response={"schema": "paperclip.question_response.v1", "answers": {"answer-" + str(i): {"text": "x" * 100000} for i in range(21)}})
        value["inputDigest"] = "sha256:" + client_module.hashlib.sha256(client_module.canonical({key: value[key] for key in ("requestId", "turnId", "response")})).hexdigest()
        with patch.object(client_module, "http", return_value=value) as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"): self.client.answer(ASSIGNMENT, "question-one")
            self.assertFalse(any(call.args[1].get("command") for call in transport.call_args_list))
        self.assertFalse(self.input_path().exists())

    def test_committed_migration_detects_source_missing_target_and_identity_tampering(self):
        rows = self.historical_rows(1); request = "question-1"
        client_module.save(self.aggregate_input_path(), self.aggregate_record(rows))
        with patch.object(client_module, "http", return_value={k:v for k,v in rows[request].items() if k != "continuationReceiptId"}): self.client.answer(ASSIGNMENT, request)
        source = self.aggregate_input_path().read_bytes(); target = self.input_path(request).read_bytes()
        for changed in ("source", "missing", "turn", "digest", "receipt", "marker"):
            marker_path = self.input_path().parent / "migration.json"; marker = marker_path.read_bytes()
            if changed == "source": self.aggregate_input_path().write_bytes(source + b" ")
            elif changed == "missing": self.input_path(request).unlink()
            elif changed == "marker": marker_path.write_text('{"schema":"paperclip.muse_input_receipts_migration.v1","entries":{},"entries":null}')
            else:
                record = json.loads(target); row = record["inputs"][request]
                field = {"turn": "turnId", "digest": "inputDigest", "receipt": "continuationReceiptId"}[changed]
                row[field] = {"turn": "changed-turn", "digest": "sha256:" + "a" * 64, "receipt": "50000000-0000-4000-8000-000000000009"}[changed]
                client_module.save(self.input_path(request), record)
            with patch.object(client_module, "http") as transport:
                with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"): self.client.consume(ASSIGNMENT, request)
                transport.assert_not_called()
            self.aggregate_input_path().write_bytes(source); self.input_path(request).write_bytes(target); marker_path.write_bytes(marker)

    def test_migration_marker_crash_reuses_prevalidated_files_without_rewriting_them(self):
        rows = self.historical_rows(2); client_module.save(self.aggregate_input_path(), self.aggregate_record(rows)); save = client_module.save
        marker = self.input_path().parent / "migration.json"
        def interrupted(path, value):
            if path == marker: raise OSError("Synthetic marker commit lost")
            return save(path, value)
        with patch.object(client_module, "save", interrupted), patch.object(client_module, "http") as transport:
            with self.assertRaises(OSError): self.client.answer(ASSIGNMENT, "question-2")
            transport.assert_not_called()
        first = self.input_path("question-1").read_bytes(); modified = self.input_path("question-1").stat().st_mtime_ns
        self.reopen()
        with patch.object(client_module, "http", return_value={k:v for k,v in rows["question-2"].items() if k != "continuationReceiptId"}): self.client.answer(ASSIGNMENT, "question-2")
        self.assertEqual(self.input_path("question-1").read_bytes(), first); self.assertEqual(self.input_path("question-1").stat().st_mtime_ns, modified)
        self.assertTrue(marker.exists())

    def test_migration_source_change_cannot_commit_a_digest_from_different_bytes(self):
        rows = self.historical_rows(2); client_module.save(self.aggregate_input_path(), self.aggregate_record(rows))
        original = self.aggregate_input_path().read_bytes(); save = client_module.save
        def changed(path, value):
            result = save(path, value)
            if path == self.input_path("question-1"): self.aggregate_input_path().write_bytes(original + b" ")
            return result
        with patch.object(client_module, "save", changed), patch.object(client_module, "http") as transport:
            with self.assertRaisesRegex(RuntimeError, "input_receipt_invalid"): self.client.answer(ASSIGNMENT, "question-2")
            transport.assert_not_called()
        self.assertFalse((self.input_path().parent / "migration.json").exists())
        # Restore only the synthetic source changed by this test, then retry the
        # exact copies; no replacement receipt or consume identity is permitted.
        self.aggregate_input_path().write_bytes(original); self.reopen()
        with patch.object(client_module, "http", return_value={k:v for k,v in rows["question-2"].items() if k != "continuationReceiptId"}):
            answer = self.client.answer(ASSIGNMENT, "question-2")
        self.assertEqual(answer["continuationReceiptId"], rows["question-2"]["continuationReceiptId"])

if __name__ == "__main__":
    if sys.argv[1:] == ["--receiver-sequence"]:
        sequence = json.load(sys.stdin)
        BINDING, ORIGIN, SCOPE = sequence["bindingId"], sequence["origin"], sequence["scope"]
        CREDENTIAL_NAME = "custom.paperclip-muse-" + BINDING
        fixture = ClientContract()
        case = unittest.FunctionTestCase(lambda: fixture.assert_receiver_sequence(sequence["responses"]), setUp=fixture.setUp, tearDown=fixture.tearDown)
        result = unittest.TextTestRunner().run(case)
        if result.wasSuccessful():
            print(json.dumps({"outputs": ["wake", "idle", "wake", "duplicate", "wake", "idle"], "providerAcknowledgement": "not_observed"}))
        sys.exit(0 if result.wasSuccessful() else 1)
    unittest.main()
