import importlib.util
from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock, call

spec = importlib.util.spec_from_file_location('kimi_fault', Path(__file__).with_name('kimi-provider-fault.py'))
fault = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fault)
BOOT = '12345678-1234-1234-1234-123456789abc'
ROOT = {'pid': 21, 'ppid': 1, 'startTicks': '100', 'bootId': BOOT}
PARENT = {'pid': 22, 'ppid': 21, 'startTicks': '101', 'bootId': BOOT}
TARGET = {'pid': 23, 'ppid': 22, 'startTicks': '102', 'bootId': BOOT}
DIST = '/tmp/paperclip-acpx-native-fixture/distribution'
RUNTIME = '/workspace/.paperclip-runtime/paperclip-runner'
HOST_NODE = fault.PACK + '/node_modules/node/bin/node'
LOADER = 'admitted guarded loader'
CANCELLED = False


def check_cancelled():
    if CANCELLED:
        raise KeyboardInterrupt('calibration cancelled')


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.entries = [{'path': name, 'sha256': fault.digest(name.encode()), 'size': len(name), 'executable': name == fault.NODE} for name in sorted([fault.NODE, fault.ENTRY])]
        self.config = {'root': ROOT, 'binding': {'remoteCwd': '/workspace', 'runId': 'run'}, 'runtimeEnvironmentLeaseId': 'workspace-id',
                       'runnerdSha256': 'sha256:' + fault.digest(b'runner'), 'nodeSha256': 'sha256:' + fault.digest(fault.NODE.encode()),
                       'guardLoaderSha256': 'sha256:' + fault.digest(LOADER.encode()), 'closureSha256': fault.digest(json.dumps(self.entries, separators=(',', ':')).encode()),
                       'bootstrapTemplate': 'bootstrap ' + fault.PLACEHOLDER, 'guardTemplate': 'const digests={};'}
        bootstrap, guard = fault.expected_sources(self.config, DIST, self.entries)
        self.files = {DIST + '/' + fault.NODE: (fault.NODE.encode(), (1, 100)), DIST + '/' + fault.ENTRY: (fault.ENTRY.encode(), (1, 101)),
                      DIST + '/' + fault.BOOTSTRAP: (bootstrap, (1, 102)), DIST + '/' + fault.GUARD: (guard, (1, 103)),
                      RUNTIME + '/bin/paperclip-runnerd': (b'runner', (1, 90)), HOST_NODE: (fault.NODE.encode(), (1, 110)),
                      fault.PACK + '/provider-assets/kimi/linux-x64/native-closure.json': (json.dumps({'entries': self.entries}, indent=2).encode(), (1, 80))}
        self.table = {21: ROOT, 22: PARENT, 23: TARGET}
        self.args = {21: [RUNTIME + '/bin/paperclip-runnerd', '--run-id', 'run', '--environment-lease-id', 'workspace-id', '--lifecycle-mode', 'per_turn', '--state-dir', RUNTIME + '/sessions/' + 'a' * 64 + '/runner'],
                     22: [HOST_NODE, '--eval', LOADER, DIST, fault.BOOTSTRAP, '0', '0', 'commonjs', '[]', '0'], 23: ['kimi-code']}
        self.stats = {'/proc/21/exe': (90, stat.S_IFREG), '/proc/23/exe': (100, stat.S_IFREG), '/proc/23/fd/7': (100, stat.S_IFREG),
                      '/proc/24/exe': (100, stat.S_IFREG), '/proc/24/fd/7': (100, stat.S_IFREG),
                      '/proc/22/exe': (110, stat.S_IFREG), '/proc/22/fd/10': (110, stat.S_IFREG), '/proc/22/fd/4': (2, stat.S_IFDIR), '/proc/22/fd/3': (3, stat.S_IFIFO)}
        def checked_fixture_file(name, *args):
            if name.startswith('/memfd:'):
                raise FileNotFoundError(2, 'deleted executable fixture')
            return self.files[name]
        patches = [patch.object(fault, 'proc', side_effect=lambda pid, boot: self.table[pid]), patch.object(fault, 'argv', side_effect=lambda pid: self.args[pid]),
                   patch.object(fault, 'checked_runner', side_effect=lambda name: self.files[name]), patch.object(fault, 'checked_file', side_effect=checked_fixture_file),
                   patch.object(Path, 'read_text', return_value=BOOT), patch.object(os, 'listdir', side_effect=lambda name: [str(pid) for pid in self.table]),
                   patch.object(os, 'getpgid', return_value=21), patch.object(os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o500, st_dev=1, st_ino=2)),
                   patch.object(os.path, 'realpath', side_effect=lambda name: HOST_NODE if name == '/proc/22/exe' else name),
                   patch.object(os, 'readlink', return_value='/workspace'), patch.object(os, 'stat', side_effect=lambda name: SimpleNamespace(st_dev=1, st_ino=self.stats[name][0], st_mode=self.stats[name][1]))]
        for mocked in patches:
            mocked.start()
            self.addCleanup(mocked.stop)

    @contextmanager
    def parent_descriptor(self, anonymous=False, content=None):
        content = fault.NODE.encode() if content is None else content
        def metadata(inode=110):
            return SimpleNamespace(st_mode=stat.S_IFREG | 0o500, st_dev=1, st_ino=inode, st_size=len(content), st_mtime_ns=3, st_ctime_ns=4, st_nlink=0 if anonymous else 1)
        original_stat = os.stat
        def proc_stat(path):
            if path in ('/proc/22/exe', '/proc/22/fd/10'):
                return metadata(self.stats[path][0])
            return original_stat(path)
        kernel = SimpleNamespace(F_GET_SEALS=1034, F_SEAL_SEAL=1, F_SEAL_SHRINK=2, F_SEAL_GROW=4, F_SEAL_WRITE=8, fcntl=lambda fd, op: 15)
        with patch.object(os, 'open', return_value=42), patch.object(os, 'close'), patch.object(os, 'fstat', side_effect=lambda fd: metadata()), patch.object(os, 'read', side_effect=[content, b'']), patch.object(os, 'stat', side_effect=proc_stat), patch.object(os, 'readlink', side_effect=lambda path: '/memfd:paperclip-verified-launch (deleted)' if path == '/proc/self/fd/42' else '/workspace'), patch.object(fault, 'fcntl', kernel, create=True):
            yield

    def test_memfd_parent_uses_the_live_descriptor_without_reopening_deleted_alias(self):
        self.args[22][0] = '/proc/self/fd/10'
        with patch.object(os.path, 'realpath', side_effect=lambda name: '/memfd:paperclip-verified-launch (deleted)' if name == '/proc/22/exe' else name), self.parent_descriptor(True):
            receipt = fault.inspect(self.config)
        self.assertEqual(receipt['target'], TARGET)
        self.assertFalse(any('/memfd:' in str(call) for call in fault.checked_file.call_args_list))

    def test_matching_memfd_inode_and_seals_do_not_replace_the_full_node_digest(self):
        self.args[22][0] = '/proc/self/fd/10'
        with self.parent_descriptor(True, b'x' * len(fault.NODE.encode())), self.assertRaisesRegex(RuntimeError, 'parent_node'):
            fault.inspect(self.config)

    def test_exact_pinned_parent_attests_title_overwritten_child(self):
        receipt = fault.inspect(self.config)
        self.assertEqual(receipt['target'], TARGET)
        self.assertEqual(receipt['ancestry'], [TARGET, PARENT, ROOT])
        self.assertEqual(receipt['entrypointAttribution'], 'pinned_native_bootstrap_parent')
        self.assertFalse(receipt['originalChildArgvAvailable'])

    def test_held_host_node_descriptor_requires_the_same_inode(self):
        self.args[22][0] = '/proc/self/fd/10'
        with self.parent_descriptor():
            self.assertEqual(fault.inspect(self.config)['target'], TARGET)
        self.stats['/proc/22/fd/10'] = (999, stat.S_IFREG)
        with self.parent_descriptor(), self.assertRaisesRegex(RuntimeError, 'parent_node_descriptor'):
            fault.inspect(self.config)

    def test_title_alone_and_root_loss_never_select(self):
        self.args[22][4] = 'foreign.cjs'
        with self.assertRaisesRegex(RuntimeError, 'unique_native_child'):
            fault.inspect(self.config)
        self.args[22][4] = fault.BOOTSTRAP
        self.args[23] = ['node']
        with self.assertRaisesRegex(RuntimeError, 'native_title'):
            fault.inspect(self.config)

    def test_wrong_run_lease_birth_boot_and_root_executable_fail(self):
        for field, value in [('runtimeEnvironmentLeaseId', 'foreign'), ('runnerdSha256', 'sha256:' + '0' * 64), ('nodeSha256', 'sha256:' + '0' * 64), ('closureSha256', '0' * 64), ('guardLoaderSha256', 'sha256:' + '0' * 64)]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                fault.inspect({**self.config, field: value})
        for changed in [{'startTicks': '999'}, {'bootId': 'foreign'}, {'ppid': 99}]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                fault.inspect({**self.config, 'root': {**ROOT, **changed}})
        self.args[21][2] = 'foreign'
        with self.assertRaisesRegex(RuntimeError, 'root_binding'):
            fault.inspect(self.config)

    def test_native_main_node_guard_bootstrap_and_parent_code_are_exact(self):
        for name in [fault.NODE, fault.ENTRY, fault.GUARD, fault.BOOTSTRAP]:
            original = self.files[DIST + '/' + name]
            self.files[DIST + '/' + name] = (b'changed', original[1])
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                fault.inspect(self.config)
            self.files[DIST + '/' + name] = original
        for index, value in [(2, 'foreign loader'), (5, '1'), (8, '["module"]'), (0, '/foreign/node')]:
            original = self.args[22][index]
            self.args[22][index] = value
            with self.subTest(index=index), self.assertRaises(RuntimeError):
                fault.inspect(self.config)
            self.args[22][index] = original

    def test_live_executable_and_retained_descriptors_must_match(self):
        for name in ['/proc/23/exe', '/proc/23/fd/7', '/proc/22/fd/4']:
            original = self.stats[name]
            self.stats[name] = (999, original[1])
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                fault.inspect(self.config)
            self.stats[name] = original
        self.stats['/proc/22/fd/3'] = (3, stat.S_IFREG)
        with self.assertRaisesRegex(RuntimeError, 'parent_source_pipe'):
            fault.inspect(self.config)

    def test_cwd_ancestry_birth_and_ambiguity_fail_closed(self):
        with patch.object(os, 'readlink', return_value='/foreign'), self.assertRaisesRegex(RuntimeError, 'cwd'):
            fault.inspect(self.config)
        self.table[23] = {**TARGET, 'startTicks': '99'}
        with self.assertRaisesRegex(RuntimeError, 'unique_native_child'):
            fault.inspect(self.config)
        self.table[23] = TARGET
        self.table[24] = {**TARGET, 'pid': 24}
        self.args[24] = ['kimi-code']
        with self.assertRaisesRegex(RuntimeError, 'unique_native_child'):
            fault.inspect(self.config)

    def test_canonical_closure_metadata_rejects_replaced_unsorted_or_open_entries(self):
        for changed in [list(reversed(self.entries)), [*self.entries, self.entries[-1]], [{**self.entries[0], 'path': '../escape'}, self.entries[1]], [{**self.entries[0], 'extra': True}, self.entries[1]]]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                fault.parse_closure(json.dumps({'entries': changed}).encode(), self.config['closureSha256'])


class ParentDescriptorTests(unittest.TestCase):
    def setUp(self):
        self.content = b'pinned node bytes'
        self.before = SimpleNamespace(st_mode=stat.S_IFREG | 0o500, st_dev=1, st_ino=110, st_size=len(self.content), st_mtime_ns=3, st_ctime_ns=4, st_nlink=0)
        self.stats = {'/proc/22/fd/10': self.before, '/proc/22/exe': self.before}
        self.opened = Mock(return_value=42)
        self.closed = Mock()
        self.fstat = Mock(side_effect=lambda fd: self.before)
        self.read = Mock(side_effect=[self.content, b''])
        self.readlink = Mock(return_value='/memfd:paperclip-verified-launch (deleted)')
        self.kernel = SimpleNamespace(F_GET_SEALS=1034, F_SEAL_SEAL=1, F_SEAL_SHRINK=2, F_SEAL_GROW=4, F_SEAL_WRITE=8, fcntl=Mock(return_value=15))
        patches = [patch.object(os, 'open', self.opened), patch.object(os, 'close', self.closed), patch.object(os, 'fstat', self.fstat), patch.object(os, 'read', self.read), patch.object(os, 'stat', side_effect=lambda path: self.stats[path]), patch.object(os, 'readlink', self.readlink), patch.object(fault, 'fcntl', self.kernel, create=True)]
        for mocked in patches:
            mocked.start()
            self.addCleanup(mocked.stop)

    def test_sealed_memfd_requires_complete_bytes_and_same_kernel_executable(self):
        self.assertEqual(fault.checked_parent_descriptor(22), (self.content, (1, 110)))
        self.opened.assert_called_once_with('/proc/22/fd/10', os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        self.kernel.fcntl.assert_has_calls([call(42, 1034), call(42, 1034)])
        self.closed.assert_called_once_with(42)

    def test_linked_descriptor_keeps_regular_single_link_checks_without_memfd_claim(self):
        self.before.st_nlink = 1
        self.assertEqual(fault.checked_parent_descriptor(22), (self.content, (1, 110)))
        self.kernel.fcntl.assert_not_called()
        self.readlink.assert_not_called()

    def test_every_missing_kernel_seal_fails_before_read(self):
        for bit in (1, 2, 4, 8):
            with self.subTest(bit=bit):
                self.kernel.fcntl.return_value = 15 ^ bit
                with self.assertRaisesRegex(RuntimeError, 'parent_memfd_seals'):
                    fault.checked_parent_descriptor(22)
        self.read.assert_not_called()
        self.assertEqual(self.closed.call_count, 4)

    def test_an_unlinked_regular_file_cannot_impersonate_the_authenticated_memfd(self):
        self.readlink.return_value = '/tmp/node (deleted)'
        with self.assertRaisesRegex(RuntimeError, 'parent_memfd_required'):
            fault.checked_parent_descriptor(22)
        self.read.assert_not_called()
        self.kernel.fcntl.assert_not_called()

    def test_memfd_write_mode_and_missing_seal_api_fail_closed(self):
        self.before.st_mode = stat.S_IFREG | 0o700
        with self.assertRaisesRegex(RuntimeError, 'parent_memfd_required'):
            fault.checked_parent_descriptor(22)
        self.before.st_mode = stat.S_IFREG | 0o500
        del self.kernel.F_GET_SEALS
        with self.assertRaisesRegex(RuntimeError, 'parent_memfd_required'):
            fault.checked_parent_descriptor(22)
        self.read.assert_not_called()

    def test_different_held_descriptor_or_executable_never_attests(self):
        for path in ('/proc/22/fd/10', '/proc/22/exe'):
            with self.subTest(path=path):
                self.stats[path] = SimpleNamespace(**{**vars(self.before), 'st_ino': 999})
                with self.assertRaisesRegex(RuntimeError, 'parent_node_descriptor'):
                    fault.checked_parent_descriptor(22)
                self.stats[path] = self.before
        self.read.assert_not_called()

    def test_descriptor_metadata_change_during_read_is_rejected(self):
        changed = SimpleNamespace(**{**vars(self.before), 'st_ctime_ns': 99})
        self.fstat.side_effect = [self.before, changed]
        with self.assertRaisesRegex(RuntimeError, 'parent_descriptor_changed'):
            fault.checked_parent_descriptor(22)
        self.closed.assert_called_once_with(42)

    def test_short_read_or_changed_seals_cannot_attest(self):
        self.read.side_effect = [b'short', b'']
        with self.assertRaisesRegex(RuntimeError, 'parent_descriptor_changed'):
            fault.checked_parent_descriptor(22)
        self.read.side_effect = [self.content, b'']
        self.kernel.fcntl.side_effect = [15, 7]
        with self.assertRaisesRegex(RuntimeError, 'parent_memfd_seals'):
            fault.checked_parent_descriptor(22)

    def test_nonregular_oversized_or_multilink_handles_fail_before_read(self):
        for field, value in [('st_mode', stat.S_IFIFO), ('st_nlink', 2), ('st_size', 256 * 1024 * 1024 + 1)]:
            with self.subTest(field=field):
                before = getattr(self.before, field)
                setattr(self.before, field, value)
                with self.assertRaisesRegex(RuntimeError, 'parent_descriptor_shape'):
                    fault.checked_parent_descriptor(22)
                setattr(self.before, field, before)
        self.read.assert_not_called()


class PidfdTests(unittest.TestCase):
    def test_changed_retired_or_reused_pidfd_never_signals(self):
        before = {'target': TARGET}
        for second, fdinfo in [({'target': {**TARGET, 'startTicks': '999'}}, 'Pid:\t23\n'), (before, 'Pid:\t-1\n')]:
            with patch.object(sys, 'platform', 'linux'), patch.object(fault, 'inspect', side_effect=[before, second]), patch.object(os, 'pidfd_open', return_value=42, create=True), patch.object(signal, 'pidfd_send_signal', create=True) as sent, patch.object(os, 'close') as closed, patch.object(Path, 'read_text', return_value=fdinfo):
                with self.assertRaises(RuntimeError):
                    fault.terminate({'root': ROOT})
                sent.assert_not_called()
                closed.assert_called_once_with(42)

    def test_only_held_native_child_pidfd_receives_sigkill(self):
        before = {'target': TARGET}
        with patch.object(sys, 'platform', 'linux'), patch.object(fault, 'inspect', return_value=before), patch.object(os, 'pidfd_open', return_value=42, create=True) as opened, patch.object(signal, 'pidfd_send_signal', create=True) as sent, patch.object(os, 'close') as closed, patch.object(Path, 'read_text', return_value='Pid:\t23\n'):
            receipt = fault.terminate({'root': ROOT, 'binding': {}, 'runtimeEnvironmentLeaseId': 'lease'})
            opened.assert_called_once_with(23)
            sent.assert_called_once_with(42, signal.SIGKILL, None, 0)
            closed.assert_called_once_with(42)
            self.assertFalse(receipt['workerSignalled'])

    def test_worker_or_current_process_never_opens_a_pidfd(self):
        for pid in [ROOT['pid'], os.getpid()]:
            with patch.object(sys, 'platform', 'linux'), patch.object(fault, 'inspect', return_value={'target': {**TARGET, 'pid': pid}}), patch.object(os, 'pidfd_open', create=True) as opened, patch.object(signal, 'pidfd_send_signal', create=True):
                with self.assertRaisesRegex(RuntimeError, 'not_worker'):
                    fault.terminate({'root': ROOT})
                opened.assert_not_called()

    def test_sealed_files_reject_links_mutability_and_extra_hardlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary).resolve() / 'pinned'
            path.write_bytes(b'pinned')
            with self.assertRaisesRegex(RuntimeError, 'file_writable'):
                fault.checked_file(str(path), 100, True)
            path.chmod(0o400)
            self.assertEqual(fault.checked_file(str(path), 100, True)[0], b'pinned')
            link = path.with_name('link')
            link.symlink_to(path)
            with self.assertRaisesRegex(RuntimeError, 'file_realpath'):
                fault.checked_file(str(link), 100, True)
            os.link(path, path.with_name('hardlink'))
            with self.assertRaisesRegex(RuntimeError, 'file_shape'):
                fault.checked_file(str(path), 100, True)

    def test_preinstalled_runner_link_is_bound_to_its_resolved_inode(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary).resolve() / 'installed-runner'
            binary.write_bytes(b'pinned runner')
            link = binary.with_name('runtime-runner')
            link.symlink_to(binary)
            self.assertEqual(fault.checked_runner(str(link)), fault.checked_runner(str(binary)))

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Native Linux pidfd calibration required')
    def test_real_title_overwritten_native_child_uses_pidfd_and_leaves_worker_alive(self):
        node = shutil.which('node')
        self.assertIsNotNone(node)
        base = Path(tempfile.mkdtemp(prefix='kimi-fault-calibration-', dir='/tmp'))
        snapshot = Path(tempfile.mkdtemp(prefix='paperclip-acpx-native-', dir='/tmp'))
        distribution = snapshot / 'distribution'
        workspace = base / 'workspace'
        runtime = workspace / '.paperclip-runtime/paperclip-runner'
        pack = base / 'pack'
        host_node = pack / 'node_modules/node/bin/node'
        root_child = None
        owned = []
        try:
            for path in [distribution / fault.NODE, distribution / fault.ENTRY, runtime / 'bin/paperclip-runnerd', host_node]:
                path.parent.mkdir(parents=True, exist_ok=True)
            for path in [distribution / fault.NODE, runtime / 'bin/paperclip-runnerd', host_node]:
                shutil.copyfile(node, path)
                path.chmod(0o500)
            ready = workspace / 'ready.json'
            (distribution / fault.ENTRY).write_text('import fs from "node:fs";process.title="kimi-code";fs.writeFileSync(' + json.dumps(str(ready)) + ',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);')
            entries = [{'path': name, 'sha256': fault.digest((distribution / name).read_bytes()), 'size': (distribution / name).stat().st_size, 'executable': name == fault.NODE} for name in sorted([fault.NODE, fault.ENTRY])]
            closure = pack / 'provider-assets/kimi/linux-x64/native-closure.json'
            closure.parent.mkdir(parents=True)
            closure.write_text(json.dumps({'entries': entries}))
            loader = 'const source=require("node:fs").readFileSync(3,"utf8");require("node:vm").runInThisContext(source);'
            template = 'const fs=require("node:fs"),cp=require("node:child_process");const fd=fs.openSync(' + json.dumps(fault.PLACEHOLDER + '/' + fault.NODE) + ',"r");const child=cp.spawn("/proc/self/fd/7",["--require",' + json.dumps(fault.PLACEHOLDER + '/' + fault.GUARD) + ',' + json.dumps(fault.PLACEHOLDER + '/' + fault.ENTRY) + ',"acp"],{stdio:["ignore","ignore","ignore","ignore","ignore","ignore","ignore",fd]});fs.closeSync(fd);child.on("exit",()=>process.exit(0));process.on("SIGTERM",()=>child.kill("SIGTERM"));'
            config = {'binding': {'remoteCwd': str(workspace), 'runId': 'fixture'}, 'runtimeEnvironmentLeaseId': 'workspace-id', 'runnerdSha256': 'sha256:' + fault.digest((runtime / 'bin/paperclip-runnerd').read_bytes()),
                      'closureSha256': fault.digest(json.dumps(entries, separators=(',', ':'), ensure_ascii=False).encode()), 'nodeSha256': 'sha256:' + fault.digest((distribution / fault.NODE).read_bytes()),
                      'guardLoaderSha256': 'sha256:' + fault.digest(loader.encode()), 'bootstrapTemplate': template, 'guardTemplate': 'const digests={};'}
            bootstrap, guard = fault.expected_sources(config, str(distribution), entries)
            (distribution / fault.BOOTSTRAP).write_bytes(bootstrap)
            (distribution / fault.GUARD).write_bytes(guard)
            script = base / 'root.cjs'
            script.write_text('const fs=require("node:fs"),cp=require("node:child_process");const directory=fs.openSync(' + json.dumps(str(distribution)) + ',"r");const child=cp.spawn(' + json.dumps(str(host_node)) + ',["--eval",' + json.dumps(loader) + ',' + json.dumps(str(distribution)) + ',' + json.dumps(fault.BOOTSTRAP) + ',"0","0","commonjs","[]","0"],{detached:true,stdio:["ignore","ignore","ignore","pipe",directory]});fs.closeSync(directory);child.stdio[3].end(fs.readFileSync(' + json.dumps(str(distribution / fault.BOOTSTRAP)) + '));process.on("SIGTERM",()=>{if(child.exitCode!==null||child.signalCode!==null)process.exit(0);child.once("exit",()=>process.exit(0));child.kill("SIGTERM")});setInterval(()=>{},1000);')
            for directory, _, files in os.walk(snapshot):
                for name in files:
                    path = Path(directory) / name
                    path.chmod(0o500 if path == distribution / fault.NODE else 0o400)
                Path(directory).chmod(0o500)
            check_cancelled()
            root_child = subprocess.Popen([str(runtime / 'bin/paperclip-runnerd'), str(script), '--run-id', 'fixture', '--environment-lease-id', 'workspace-id', '--lifecycle-mode', 'per_turn', '--state-dir', str(runtime / 'sessions' / ('a' * 64) / 'runner')], cwd=workspace, env={'PATH': '/usr/bin:/bin'}, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            owned.append(os.pidfd_open(root_child.pid))
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                check_cancelled()
                time.sleep(.02)
            self.assertTrue(ready.exists())
            target = json.loads(ready.read_text())['pid']
            self.assertEqual(fault.argv(target), ['kimi-code'])
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            config['root'] = fault.proc(root_child.pid, boot)
            with patch.object(fault, 'PACK', str(pack)):
                before = fault.inspect(config)
                for identity in before['ancestry'][:-1]:
                    fd = os.pidfd_open(identity['pid'])
                    owned.append(fd)
                    self.assertEqual(fault.proc(identity['pid'], boot), identity)
                check_cancelled()
                receipt = fault.terminate(config)
            self.assertEqual(receipt['target']['pid'], target)
            self.assertFalse(receipt['workerSignalled'])
            self.assertEqual(select.select([owned[0]], [], [], 0)[0], [])
            self.assertTrue(select.select([owned[1]], [], [], 3)[0])
        finally:
            if root_child is not None:
                if owned:
                    try:
                        signal.pidfd_send_signal(owned[0], signal.SIGTERM, None, 0)
                    except ProcessLookupError:
                        pass
                elif root_child.poll() is None:
                    root_child.terminate()
                try:
                    root_child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if owned:
                        signal.pidfd_send_signal(owned[0], signal.SIGKILL, None, 0)
                        root_child.wait(timeout=3)
                for fd in reversed(owned[1:]):
                    if not select.select([fd], [], [], 0)[0]:
                        try:
                            signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
                        except ProcessLookupError:
                            pass
            for fd in owned:
                os.close(fd)
            for directory, _, _ in os.walk(snapshot):
                os.chmod(directory, 0o700)
            shutil.rmtree(snapshot)
            shutil.rmtree(base)


if __name__ == '__main__':
    def cancelled(_signum, _frame):
        global CANCELLED
        CANCELLED = True
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    unittest.main()
