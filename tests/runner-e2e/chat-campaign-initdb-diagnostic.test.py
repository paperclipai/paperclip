import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('diagnostic', pathlib.Path(__file__).with_name('chat-campaign-initdb-diagnostic.py'))
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)

class DiagnosticGuardTests(unittest.TestCase):
    def test_wrong_binary_rejected_before_spawn(self):
        with patch.object(diag.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'Unverified'):
                diag.validate('/bin/echo', 'not-the-pinned-binary', pathlib.Path('/private/tmp/unowned'), 'token')
            spawn.assert_not_called()

    def test_wrong_root_rejected_even_with_matching_binary_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = pathlib.Path(temporary).resolve() / 'initdb'; binary.write_text('offline synthetic fixture')
            with patch.object(diag, 'BINARY', binary), patch.object(diag.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(ValueError, 'Wrong owned'):
                    diag.validate(binary, diag.sha(binary), pathlib.Path(temporary), 'token')
                spawn.assert_not_called()

    def test_wrong_owner_receipt_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix=diag.PREFIX, dir='/private/tmp') as temporary:
            root = pathlib.Path(temporary); binary = root / 'initdb'; binary.write_text('offline synthetic fixture')
            diag.private_json(root / 'owner.json', {'version': 1, 'creatorPid': os.getpid(), 'uid': os.getuid(), 'token': 'correct'})
            with patch.object(diag, 'BINARY', binary):
                with self.assertRaisesRegex(ValueError, 'receipt mismatch'):
                    diag.validate(binary, diag.sha(binary), root, 'wrong')
                (root / 'owner.json').chmod(0o644)
                with self.assertRaisesRegex(ValueError, 'Unsafe owner'):
                    diag.validate(binary, diag.sha(binary), root, 'correct')

    def test_only_sanitized_cause_is_public(self):
        secret = 'synthetic-private-password'
        result = diag.cause('FATAL: could not start ' + secret + '\nordinary raw details\n', secret)
        self.assertNotIn(secret, json.dumps(result))
        self.assertIn('[REDACTED]', result[0])
        self.assertNotIn('ordinary raw details', json.dumps(result))

    def test_unowned_group_cannot_be_signaled(self):
        with self.assertRaisesRegex(RuntimeError, 'safely verified'):
            diag.verify_members([{'uid': os.getuid(), 'executable': '/bin/unrelated'}])

    def test_secondary_ownership_guard_retains_observation_without_throwing_away_capture(self):
        observed, findings = {}, []
        row = {'pid': 123, 'uid': os.getuid(), 'executable': '/bin/transient-unverified'}
        with patch.object(diag.os, 'killpg') as signal_group:
            diag.record_members([row], observed, findings)
            self.assertEqual(observed[123], row)
            self.assertTrue(findings)
            signal_group.assert_not_called()

if __name__ == '__main__':
    unittest.main()
