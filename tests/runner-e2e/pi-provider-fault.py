"""One-shot Linux Pi-child fault. No environment reads; never targets a worker.

The caller is the nonce-bound remote observer. Its already admitted lease and
run root are rechecked here, then pidfd pins the exact child across PID reuse.
This helper does not relax provider admission or manufacture runtime events.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

PACK = '/opt/paperclip-runner/provider-pack'
ENTRY = 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
NODE = 'node/bin/node'
EXTENSION = 'extensions/paperclip.js'
GUARD = '.paperclip-native-module-guard.cjs'


def require(value, code):
    if not value:
        raise RuntimeError('pi_provider_fault:' + code)


def proc(pid, boot):
    raw = Path(f'/proc/{pid}/stat').read_text()
    require(raw.startswith(f'{pid} ('), 'stat_pid')
    fields = raw.rsplit(') ', 1)[1].split()
    require(fields[0] != 'Z', 'dead_process')
    return {'pid': pid, 'ppid': int(fields[1]), 'startTicks': fields[19], 'bootId': boot}


def argv(pid):
    raw = Path(f'/proc/{pid}/cmdline').read_bytes()
    require(0 < len(raw) <= 32768, 'argv_bound')
    return raw.decode().rstrip('\0').split('\0')


def flag(args, name):
    require(args.count(name) == 1 and args.index(name) + 1 < len(args), 'flag_' + name)
    return args[args.index(name) + 1]


def checked_file(path, maximum, sealed=False):
    require(os.path.realpath(path) == path, 'file_realpath')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum, 'file_shape')
        if sealed:
            require(before.st_mode & 0o222 == 0, 'file_writable')
        chunks = []
        while True:
            chunk = os.read(fd, min(1024 * 1024, maximum + 1))
            if not chunk:
                break
            chunks.append(chunk)
            require(sum(map(len, chunks)) <= maximum, 'file_bound')
        after, named = os.fstat(fd), os.lstat(path)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink)
        require(identity(before) == identity(after) == identity(named), 'file_changed')
        return b''.join(chunks), (before.st_dev, before.st_ino)
    finally:
        os.close(fd)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect(config):
    require(set(config) == {'root', 'binding', 'runtimeEnvironmentLeaseId', 'runnerdSha256', 'closureSha256'}, 'config_keys')
    binding, expected = config['binding'], config['root']
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    require(re.fullmatch(r'[a-f0-9-]{36}', boot) and boot == expected['bootId'], 'boot_changed')
    root = proc(expected['pid'], boot)
    require(root == expected and os.getpgid(root['pid']) == root['pid'], 'root_changed')
    root_args = argv(root['pid'])
    runtime_root = binding['remoteCwd'] + '/.paperclip-runtime/paperclip-runner'
    runner = runtime_root + '/bin/paperclip-runnerd'
    require(root_args[0] == runner and flag(root_args, '--run-id') == binding['runId']
            and flag(root_args, '--environment-lease-id') == config['runtimeEnvironmentLeaseId']
            and flag(root_args, '--lifecycle-mode') == 'per_turn', 'root_binding')
    require(re.fullmatch(re.escape(runtime_root) + r'/sessions/[a-f0-9]{64}/runner', flag(root_args, '--state-dir')), 'root_session')
    runner_bytes, runner_inode = checked_file(runner, 256 * 1024 * 1024)
    executable = os.stat(f'/proc/{root["pid"]}/exe')
    require((executable.st_dev, executable.st_ino) == runner_inode and 'sha256:' + digest(runner_bytes) == config['runnerdSha256'], 'runner_executable')
    closure_bytes, _ = checked_file(PACK + '/provider-assets/pi/linux-x64/native-closure.json', 4 * 1024 * 1024)
    require(digest(closure_bytes) == config['closureSha256'], 'closure_pin')
    manifest = json.loads(closure_bytes)
    entries = {e['path']: e for e in manifest['entries']}
    require(len(entries) == len(manifest['entries']), 'closure_duplicate')
    for name in (NODE, ENTRY, EXTENSION, 'pi-entry.cjs', 'node_modules/pi-acp/dist/index.js', 'node_modules/pi-acp/dist/paperclip-runtime.js'):
        require(name in entries and re.fullmatch(r'[a-f0-9]{64}', entries[name]['sha256']), 'closure_entry')
    pids = [int(p) for p in os.listdir('/proc') if p.isdigit() and int(p) > 1]
    require(len(pids) <= 4096, 'process_bound')
    table = {}
    for pid in pids:
        try:
            table[pid] = proc(pid, boot)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except RuntimeError as error:
            if str(error).endswith(':dead_process'):
                continue
            raise
    def ancestry(pid):
        chain = []
        while pid != root['pid']:
            require(pid in table and len(chain) < 64 and pid not in [p['pid'] for p in chain], 'ancestry')
            chain.append(table[pid]); pid = table[pid]['ppid']
        return chain + [root]
    matches = []
    for pid in table:
        try:
            chain = ancestry(pid)
        except RuntimeError:
            continue
        parent = table[pid]['ppid']
        if parent not in table:
            continue
        parent_args = argv(parent)
        if len(parent_args) != 4 or not parent_args[3].endswith('/distribution/pi-entry.cjs'):
            continue
        distribution = parent_args[3][:-len('/pi-entry.cjs')]
        require(re.fullmatch(r'/tmp/paperclip-acpx-native-[A-Za-z0-9_-]+/distribution', distribution), 'snapshot_path')
        require(parent_args == [distribution + '/' + NODE, '--require', distribution + '/' + GUARD, distribution + '/pi-entry.cjs'], 'wrapper_parent')
        # Pi sets process.title and overwrites Linux argv. The exact pinned
        # parent's launch code attests the entrypoint; title alone never selects.
        require(argv(pid) == ['pi'], 'pi_process_title')
        for directory in (distribution, os.path.dirname(distribution)):
            st = os.lstat(directory)
            require(stat.S_ISDIR(st.st_mode) and not st.st_mode & 0o222 and os.path.realpath(directory) == directory, 'snapshot_seal')
        require(os.readlink(f'/proc/{pid}/cwd') == binding['remoteCwd'], 'cwd')
        identities = {}
        for name in (NODE, ENTRY, EXTENSION, 'pi-entry.cjs', 'node_modules/pi-acp/dist/index.js', 'node_modules/pi-acp/dist/paperclip-runtime.js'):
            content, inode = checked_file(distribution + '/' + name, 256 * 1024 * 1024, True)
            require(len(content) == entries[name]['size'] and digest(content) == entries[name]['sha256'], 'snapshot_digest')
            identities[name] = inode
        exe = os.stat(f'/proc/{pid}/exe')
        require((exe.st_dev, exe.st_ino) == identities[NODE], 'pi_executable')
        parent_exe = os.stat(f'/proc/{parent}/exe')
        require((parent_exe.st_dev, parent_exe.st_ino) == identities[NODE], 'wrapper_executable')
        for identity in chain:
            require(proc(identity['pid'], boot) == identity, 'ancestry_changed')
        matches.append({'target': table[pid], 'ancestry': chain, 'nodeSha256': 'sha256:' + entries[NODE]['sha256'],
                        'entrypointSha256': 'sha256:' + entries[ENTRY]['sha256'], 'closureSha256': config['closureSha256'],
                        'entrypointAttribution': 'pinned_wrapper_parent', 'originalChildArgvAvailable': False, 'observedChildTitle': 'pi'})
    require(len(matches) == 1, 'unique_pi_child')
    return matches[0]


def terminate(config):
    require(sys.platform == 'linux' and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'pidfd_required')
    before = inspect(config)
    pid = before['target']['pid']
    require(pid != os.getpid() and pid != config['root']['pid'], 'not_worker')
    fd = os.pidfd_open(pid)
    try:
        require(inspect(config) == before, 'identity_changed_after_pidfd')
        fields = dict(line.split(':', 1) for line in Path(f'/proc/self/fdinfo/{fd}').read_text().splitlines() if ':' in line)
        require(int(fields.get('Pid', '-1').strip()) == pid, 'pidfd_retired')
        signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
        return {'schema': 'paperclip.e2e.pi-provider-death.v1', 'binding': config['binding'], 'runtimeEnvironmentLeaseId': config['runtimeEnvironmentLeaseId'],
                **before, 'signalled': True, 'signal': 'SIGKILL', 'targetKind': 'pi_native_child', 'workerSignalled': False}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2 and len(sys.argv[1]) <= 8192, 'input_bound')
        print(json.dumps(terminate(json.loads(base64.b64decode(sys.argv[1], validate=True))), separators=(',', ':')))
    except Exception:
        # Never print process arguments, filesystem paths, or inherited context.
        print(json.dumps({'ok': False, 'code': 'pi_provider_identity_or_signal_failed'}))
        sys.exit(1)
