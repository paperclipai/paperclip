import importlib.util
import base64
import json
from pathlib import Path
import signal
import subprocess
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import Mock, patch

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

fault = load('original_fault', 'kimi-provider-fault.py')
diagnostic = load('diagnostic_fault', 'kimi-provider-fault-diagnostic.py')

class DiagnosticTests(unittest.TestCase):
    def test_exact_selector_source_hash_admits_only_the_frozen_source(self):
        worker = Path(__file__).with_name('kimi-provider-fault-diagnostic.py')
        source = Path(__file__).with_name('kimi-provider-fault.py').read_bytes()
        config = base64.b64encode(b'{}').decode()
        response = subprocess.run([sys.executable, '-I', str(worker), base64.b64encode(source).decode(), config], capture_output=True, text=True, timeout=5)
        self.assertEqual(response.returncode, 1)
        result = json.loads(response.stdout)
        self.assertNotEqual(result['stage'], 'input')
        self.assertIn(result['failingGuard'], ['pidfd_required', 'config_keys'])
        self.assertIs(result['signalDispatched'], False)
        rejected = subprocess.run([sys.executable, '-I', str(worker), base64.b64encode(source + b'\n').decode(), config], capture_output=True, text=True, timeout=5)
        self.assertEqual(rejected.returncode, 1)
        refused = json.loads(rejected.stdout)
        self.assertEqual(refused['stage'], 'input')
        self.assertIs(refused['signalDispatched'], False)

    def test_missing_signal_capability_is_preserved_and_fails_original_guard(self):
        missing = SimpleNamespace(SIGKILL=signal.SIGKILL)
        with patch.object(sys, 'platform', 'linux'), patch.object(fault, 'signal', missing), patch.object(fault, 'os', SimpleNamespace(pidfd_open=Mock())):
            result = diagnostic.run(fault, {}, True)
            self.assertFalse(hasattr(missing, 'pidfd_send_signal'))
        self.assertEqual(result['failingGuard'], 'pidfd_required')
        self.assertEqual(result['stage'], 'terminate')
        self.assertIs(result['signalDispatched'], False)

    def test_malformed_worker_input_has_one_closed_full_schema(self):
        worker = Path(__file__).with_name('kimi-provider-fault-diagnostic.py')
        response = subprocess.run([sys.executable, '-I', str(worker), 'private_invalid_source', 'private_invalid_config'], capture_output=True, text=True, timeout=5)
        self.assertEqual(response.returncode, 1)
        result = json.loads(response.stdout)
        self.assertEqual(set(result), {'schema', 'qualification', 'stage', 'status', 'failingGuard', 'errno', 'signalAttempted', 'signalDispatched', 'receipt', 'externalModelCalls'})
        self.assertEqual(result['stage'], 'input')
        self.assertIs(result['signalDispatched'], False)
        self.assertNotIn('private', response.stdout)

    def test_original_require_remains_untouched_and_terminal_guard_is_closed(self):
        original = fault.require
        with patch.object(sys, 'platform', 'linux'), patch.object(fault.os, 'pidfd_open', create=True) as opened, patch.object(signal, 'pidfd_send_signal', create=True) as sent:
            result = diagnostic.run(fault, {}, True)
        self.assertEqual(result['failingGuard'], 'config_keys')
        self.assertEqual(result['stage'], 'inspect_before')
        self.assertIs(result['signalDispatched'], False)
        self.assertIs(fault.require, original)
        opened.assert_not_called()
        sent.assert_not_called()

    def test_actual_original_terminate_keeps_two_inspections_and_one_signal(self):
        before = {'target': {'pid': 23}}
        original = fault.require
        with patch.object(sys, 'platform', 'linux'), patch.object(fault, 'inspect', Mock(return_value=before)) as inspected, patch.object(fault.os, 'pidfd_open', Mock(return_value=42), create=True) as opened, patch.object(signal, 'pidfd_send_signal', Mock(), create=True) as sent, patch.object(fault.os, 'close') as closed, patch.object(Path, 'read_text', return_value='Pid:\t23\n'):
            result = diagnostic.run(fault, {'root': {'pid': 21}, 'binding': {}, 'runtimeEnvironmentLeaseId': 'lease'}, True)
        self.assertEqual(result['status'], 'PASS')
        self.assertIs(result['signalDispatched'], True)
        self.assertEqual(inspected.call_count, 2)
        opened.assert_called_once_with(23)
        sent.assert_called_once_with(42, signal.SIGKILL, None, 0)
        closed.assert_called_once_with(42)
        self.assertIs(fault.require, original)

    def test_failed_signal_call_remains_unknown_and_restores_wrappers(self):
        before = {'target': {'pid': 23}}
        with patch.object(sys, 'platform', 'linux'), patch.object(fault, 'inspect', Mock(return_value=before)) as inspected, patch.object(fault.os, 'pidfd_open', Mock(return_value=42), create=True) as opened, patch.object(signal, 'pidfd_send_signal', Mock(side_effect=OSError(38, 'private kernel details')), create=True) as sent, patch.object(fault.os, 'close'), patch.object(Path, 'read_text', return_value='Pid:\t23\n'):
            result = diagnostic.run(fault, {'root': {'pid': 21}, 'binding': {}, 'runtimeEnvironmentLeaseId': 'lease'}, True)
            self.assertIs(fault.inspect, inspected)
            self.assertIs(fault.os.pidfd_open, opened)
            self.assertIs(fault.signal.pidfd_send_signal, sent)
        self.assertEqual(result['stage'], 'signal')
        self.assertIsNone(result['signalDispatched'])
        self.assertNotIn('private', json.dumps(result))

    def test_caught_unrelated_ancestry_rejection_does_not_become_a_failure(self):
        def inspect(config):
            try:
                fault.require(False, 'ancestry')
            except RuntimeError:
                pass
            return {'target': {'pid': 23}}
        with patch.object(fault, 'inspect', inspect), patch.object(signal, 'pidfd_send_signal', Mock(), create=True) as sent:
            result = diagnostic.run(fault, {}, False)
        self.assertEqual(result['status'], 'PASS')
        self.assertIsNone(result['failingGuard'])
        self.assertIs(result['signalDispatched'], False)
        sent.assert_not_called()

    def test_caught_guard_cannot_mask_a_later_os_error(self):
        def inspect(config):
            try:
                fault.require(False, 'ancestry')
            except RuntimeError:
                pass
            raise OSError(13, 'private path')
        with patch.object(fault, 'inspect', inspect), patch.object(signal, 'pidfd_send_signal', Mock(), create=True) as sent:
            result = diagnostic.run(fault, {}, False)
        self.assertEqual(result['status'], 'FAIL')
        self.assertIsNone(result['failingGuard'])
        self.assertEqual(result['stage'], 'inspect_before')
        self.assertIs(result['signalDispatched'], False)
        self.assertNotIn('private', json.dumps(result))
        sent.assert_not_called()

if __name__ == '__main__':
    unittest.main()
