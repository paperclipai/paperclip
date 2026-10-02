"""Credential-free admission tests; real pidfd calibration runs only on Linux."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import select
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pi_fault', Path(__file__).with_name('pi-provider-fault.py'))
fault = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fault)
BOOT = '12345678-1234-1234-1234-123456789abc'
ROOT = {'pid': 21, 'ppid': 1, 'startTicks': '100', 'bootId': BOOT}
PARENT = {'pid': 22, 'ppid': 21, 'startTicks': '101', 'bootId': BOOT}
TARGET = {'pid': 23, 'ppid': 22, 'startTicks': '102', 'bootId': BOOT}
DIST = '/tmp/paperclip-acpx-native-fixture/distribution'
RUNTIME = '/workspace/.paperclip-runtime/paperclip-runner'
CANCELLED = False

def check_cancelled():
    if CANCELLED: raise KeyboardInterrupt('calibration cancelled')


NAMES = [fault.NODE, fault.ENTRY, fault.EXTENSION, 'pi-entry.cjs', 'node_modules/pi-acp/dist/index.js', 'node_modules/pi-acp/dist/paperclip-runtime.js']


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.files = {DIST + '/' + n: (n.encode(), (1, 100 + i)) for i, n in enumerate(NAMES)}
        self.files[RUNTIME + '/bin/paperclip-runnerd'] = (b'runner', (1, 90))
        closure = json.dumps({'entries': [{'path': n, 'sha256': fault.digest(n.encode()), 'size': len(n)} for n in NAMES]}).encode()
        self.files[fault.PACK + '/provider-assets/pi/linux-x64/native-closure.json'] = (closure, (1, 80))
        self.config = {'root': ROOT, 'binding': {'remoteCwd': '/workspace', 'runId': 'run'}, 'runtimeEnvironmentLeaseId': 'workspace-id',
                       'runnerdSha256': 'sha256:' + fault.digest(b'runner'), 'closureSha256': fault.digest(closure)}
        self.table = {21: ROOT, 22: PARENT, 23: TARGET}
        self.args = {21: [RUNTIME + '/bin/paperclip-runnerd', '--run-id', 'run', '--environment-lease-id', 'workspace-id', '--lifecycle-mode', 'per_turn', '--state-dir', RUNTIME + '/sessions/' + 'a' * 64 + '/runner'],
                     22: [DIST + '/' + fault.NODE, '--require', DIST + '/' + fault.GUARD, DIST + '/pi-entry.cjs'], 23: ['pi']}
        self.patches = [patch.object(fault, 'proc', side_effect=lambda pid, boot: self.table[pid]), patch.object(fault, 'argv', side_effect=lambda pid: self.args[pid]),
                        patch.object(fault, 'checked_file', side_effect=lambda p, *a: self.files[p]), patch.object(Path, 'read_text', return_value=BOOT),
                        patch.object(os, 'listdir', return_value=['21', '22', '23']), patch.object(os, 'getpgid', return_value=21),
                        patch.object(os, 'lstat', return_value=SimpleNamespace(st_mode=0o40500)), patch.object(os.path, 'realpath', side_effect=lambda p: p),
                        patch.object(os, 'readlink', return_value='/workspace'), patch.object(os, 'stat', side_effect=lambda p: SimpleNamespace(st_dev=1, st_ino=90 if p == '/proc/21/exe' else 100))]
        for p in self.patches: p.start(); self.addCleanup(p.stop)

    def test_parent_attests_title_overwritten_child(self):
        receipt = fault.inspect(self.config)
        self.assertEqual(receipt['target'], TARGET)
        self.assertEqual(receipt['entrypointAttribution'], 'pinned_wrapper_parent')
        self.assertFalse(receipt['originalChildArgvAvailable'])
        self.assertEqual(receipt['ancestry'], [TARGET, PARENT, ROOT])

    def test_wrong_metadata_never_selects(self):
        for field, value in [('closureSha256', '0' * 64), ('runtimeEnvironmentLeaseId', 'foreign'), ('runnerdSha256', 'sha256:' + '0' * 64)]:
            with self.subTest(field=field), self.assertRaises(RuntimeError): fault.inspect({**self.config, field: value})

    def test_wrong_title_is_not_a_generic_node_selector(self):
        self.args[23] = ['node']
        with self.assertRaisesRegex(RuntimeError, 'pi_process_title'): fault.inspect(self.config)

    def test_foreign_parent_and_changed_wrapper_are_rejected(self):
        self.args[22][3] = '/foreign/pi-entry.cjs'
        with self.assertRaisesRegex(RuntimeError, 'unique_pi_child'): fault.inspect(self.config)
        self.args[22][3] = DIST + '/pi-entry.cjs'
        self.files[DIST + '/node_modules/pi-acp/dist/index.js'] = (b'changed', (1, 104))
        with self.assertRaisesRegex(RuntimeError, 'snapshot_digest'): fault.inspect(self.config)

    def test_foreign_root_reused_pid_and_wrong_cwd_are_rejected(self):
        for mutation in [{'startTicks': '999'}, {'bootId': 'foreign'}, {'ppid': 99}]:
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError): fault.inspect({**self.config, 'root': {**ROOT, **mutation}})
        with patch.object(os, 'readlink', return_value='/foreign'), self.assertRaisesRegex(RuntimeError, 'cwd'): fault.inspect(self.config)

    def test_ambiguous_direct_children_are_rejected(self):
        self.table[24] = {**TARGET, 'pid': 24}; self.args[24] = ['pi']
        with patch.object(os, 'listdir', return_value=['21', '22', '23', '24']), self.assertRaisesRegex(RuntimeError, 'unique_pi_child'): fault.inspect(self.config)


class PidfdTests(unittest.TestCase):
    def test_changed_or_retired_pidfd_never_signals_and_always_closes(self):
        before = {'target': TARGET}
        for second, fdinfo in [({'target': {**TARGET, 'startTicks': '999'}}, 'Pid:\t23\n'), (before, 'Pid:\t-1\n')]:
            with patch.object(sys, 'platform', 'linux'), patch.object(fault, 'inspect', side_effect=[before, second]), \
                 patch.object(os, 'pidfd_open', return_value=42, create=True), patch.object(signal, 'pidfd_send_signal', create=True) as sent, \
                 patch.object(os, 'close') as closed, patch.object(Path, 'read_text', return_value=fdinfo):
                with self.assertRaises(RuntimeError): fault.terminate({'root': ROOT})
                sent.assert_not_called(); closed.assert_called_once_with(42)

    def test_symlink_and_mutable_snapshot_file_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve() / 'data'; path.write_text('data')
            link = Path(tmp) / 'link'; link.symlink_to(path)
            with self.assertRaises(RuntimeError): fault.checked_file(str(link), 100, True)
            with self.assertRaises(RuntimeError): fault.checked_file(str(path), 100, True)
            path.chmod(0o400)
            self.assertEqual(fault.checked_file(str(path), 100, True)[0], b'data')

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open'), 'Hosted native Linux calibration required')
    def test_real_title_overwrite_then_exact_child_pidfd(self):
        node = shutil.which('node'); self.assertIsNotNone(node)
        base = Path(tempfile.mkdtemp(prefix='pi-fault-calibration-', dir='/tmp'))
        snapshot = Path(tempfile.mkdtemp(prefix='paperclip-acpx-native-', dir='/tmp'))
        distribution = snapshot / 'distribution'; workspace = base / 'workspace'; workspace.mkdir()
        runtime = workspace / '.paperclip-runtime/paperclip-runner'; (runtime / 'bin').mkdir(parents=True)
        pack = base / 'pack'; (pack / 'provider-assets/pi/linux-x64').mkdir(parents=True)
        root_child = None
        owned_fds = []
        try:
            for name in NAMES + [fault.GUARD]:
                p = distribution / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('// fixture\n')
            shutil.copyfile(node, distribution / fault.NODE); (distribution / fault.NODE).chmod(0o500)
            shutil.copyfile(node, runtime / 'bin/paperclip-runnerd'); (runtime / 'bin/paperclip-runnerd').chmod(0o500)
            ready = workspace / 'child.json'; exited = workspace / 'exit.json'
            (distribution / fault.ENTRY).write_text('process.title="pi"; require("node:fs").writeFileSync(' + json.dumps(str(ready)) + ',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);')
            (distribution / 'pi-entry.cjs').write_text('const p=require("node:child_process").spawn(process.execPath,["--require",' + json.dumps(str(distribution / fault.GUARD)) + ',' + json.dumps(str(distribution / fault.ENTRY)) + '],{stdio:"ignore"});p.on("exit",(code,signal)=>require("node:fs").writeFileSync(' + json.dumps(str(exited)) + ',JSON.stringify({code,signal})));process.on("SIGTERM",()=>{if(p.exitCode!==null||p.signalCode!==null)process.exit(0);p.once("exit",()=>process.exit(0));p.kill("SIGTERM")});setInterval(()=>{},1000);')
            entries = []
            for name in NAMES:
                p = distribution / name; content = p.read_bytes(); entries.append({'path': name, 'sha256': fault.digest(content), 'size': len(content)})
            closure = json.dumps({'entries': entries}).encode(); (pack / 'provider-assets/pi/linux-x64/native-closure.json').write_bytes(closure)
            for directory, dirs, files in os.walk(snapshot):
                for f in files:
                    p = Path(directory) / f; p.chmod(0o500 if p == distribution / fault.NODE else 0o400)
                Path(directory).chmod(0o500)
            script = base / 'root.cjs'; script.write_text('const p=require("node:child_process").spawn(' + json.dumps(str(distribution / fault.NODE)) + ',["--require",' + json.dumps(str(distribution / fault.GUARD)) + ',' + json.dumps(str(distribution / 'pi-entry.cjs')) + '],{stdio:"ignore"});process.on("SIGTERM",()=>{if(p.exitCode!==null||p.signalCode!==null)process.exit(0);p.once("exit",()=>process.exit(0));p.kill("SIGTERM")});setInterval(()=>{},1000);')
            check_cancelled()
            root_child = subprocess.Popen([str(runtime / 'bin/paperclip-runnerd'), str(script), '--run-id', 'fixture', '--environment-lease-id', 'workspace-id', '--lifecycle-mode', 'per_turn', '--state-dir', str(runtime / 'sessions' / ('a' * 64) / 'runner')], cwd=workspace, env={'PATH': '/usr/bin:/bin'}, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try: owned_fds.append(os.pidfd_open(root_child.pid))
            except Exception:
                # Direct Popen child has not been polled/reaped, so its numeric
                # identity cannot have been reused before this emergency stop.
                root_child.terminate(); root_child.wait(timeout=3)
                raise
            check_cancelled()
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                check_cancelled(); time.sleep(.02)
            self.assertTrue(ready.exists()); target = json.loads(ready.read_text())['pid']
            self.assertEqual(fault.argv(target), ['pi'], 'real Node process.title must overwrite argv')
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            config = {'root': fault.proc(root_child.pid, boot), 'binding': {'remoteCwd': str(workspace), 'runId': 'fixture'}, 'runtimeEnvironmentLeaseId': 'workspace-id', 'runnerdSha256': 'sha256:' + fault.digest((runtime / 'bin/paperclip-runnerd').read_bytes()), 'closureSha256': fault.digest(closure)}
            with patch.object(fault, 'PACK', str(pack)):
                admitted = fault.inspect(config)
                self.assertEqual(admitted['target']['pid'], target)
                for identity in admitted['ancestry'][:-1]:
                    fd = os.pidfd_open(identity['pid'])
                    try:
                        fields = dict(line.split(':', 1) for line in Path(f'/proc/self/fdinfo/{fd}').read_text().splitlines() if ':' in line)
                        self.assertEqual(int(fields.get('Pid', '-1').strip()), identity['pid'])
                        self.assertEqual(fault.proc(identity['pid'], boot), identity)
                        self.assertEqual(fault.inspect(config), admitted)
                    except BaseException:
                        os.close(fd); raise
                    owned_fds.append(fd)
                    check_cancelled()
                check_cancelled()
                receipt = fault.terminate(config)
            self.assertEqual(receipt['target']['pid'], target); self.assertTrue(receipt['signalled']); self.assertEqual(select.select([owned_fds[0]], [], [], 0)[0], [])
            deadline = time.monotonic() + 3
            while not exited.exists() and time.monotonic() < deadline:
                check_cancelled(); time.sleep(.02)
            self.assertEqual(json.loads(exited.read_text()), {'code': None, 'signal': 'SIGKILL'})
        finally:
            try:
                if root_child is not None and owned_fds:
                    # A pidfd never retargets a recycled numeric process group.
                    # Before readiness the synthetic root owns a SIGTERM cascade.
                    try: signal.pidfd_send_signal(owned_fds[0], signal.SIGTERM, None, 0)
                    except ProcessLookupError: pass
                    try: root_child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        for fd in reversed(owned_fds):
                            try: signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
                            except ProcessLookupError: pass
                        root_child.wait(timeout=3)
                    # Also retire individually pinned descendants if root exited
                    # unexpectedly. Readable pidfds identify already-dead children.
                    for fd in reversed(owned_fds[1:]):
                        if not select.select([fd], [], [], 0)[0]:
                            try: signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
                            except ProcessLookupError: pass
                        self.assertTrue(select.select([fd], [], [], 3)[0], 'owned descendant must retire')
            finally:
                for fd in owned_fds: os.close(fd)
                for directory, dirs, files in os.walk(snapshot): os.chmod(directory, 0o700)
                shutil.rmtree(snapshot); shutil.rmtree(base)


if __name__ == '__main__':
    def cancelled(_signum, _frame):
        # Flag only: never interrupt Popen or pidfd ownership publication.
        global CANCELLED
        CANCELLED = True
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    unittest.main()
