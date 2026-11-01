import base64
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

PACK = '/opt/paperclip-runner/provider-pack'
ENTRY = 'node_modules/@moonshot-ai/kimi-code/dist/main.mjs'
NODE = 'node/bin/node'
GUARD = '.paperclip-native-module-guard.cjs'
BOOTSTRAP = '.paperclip-native-entry.cjs'
PLACEHOLDER = '/__paperclip_kimi_fault_snapshot__/distribution'


def require(value, code):
    if not value:
        raise RuntimeError('kimi_provider_fault:' + code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def proc(pid, boot):
    raw = Path(f'/proc/{pid}/stat').read_text()
    require(raw.startswith(f'{pid} ('), 'stat_pid')
    fields = raw.rsplit(') ', 1)[1].split()
    require(len(fields) >= 20 and fields[0] != 'Z' and fields[19].isdigit(), 'dead_or_invalid_process')
    return {'pid': pid, 'ppid': int(fields[1]), 'startTicks': fields[19], 'bootId': boot}


def argv(pid):
    raw = Path(f'/proc/{pid}/cmdline').read_bytes()
    require(0 < len(raw) <= 65536, 'argv_bound')
    return raw.decode('utf8').rstrip('\0').split('\0')


def flag(args, name):
    require(args.count(name) == 1 and args.index(name) + 1 < len(args), 'root_flag')
    return args[args.index(name) + 1]


def checked_file(path, maximum, sealed=False):
    require(os.path.realpath(path) == path, 'file_realpath')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum, 'file_shape')
        require(not sealed or before.st_mode & 0o222 == 0, 'file_writable')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            require(size <= maximum, 'file_bound')
        after, named = os.fstat(fd), os.lstat(path)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_mode, value.st_nlink)
        require(size == before.st_size and identity(before) == identity(after) == identity(named), 'file_changed')
        return b''.join(chunks), (before.st_dev, before.st_ino)
    finally:
        os.close(fd)


def checked_parent_descriptor(pid):
    path = f'/proc/{pid}/fd/10'
    executable = f'/proc/{pid}/exe'
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_mode, value.st_nlink)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink in (0, 1) and 0 < before.st_size <= 256 * 1024 * 1024, 'parent_descriptor_shape')
        require(identity(before) == identity(os.stat(path)) == identity(os.stat(executable)), 'parent_node_descriptor')
        seals = None
        if before.st_nlink == 0:
            require(all(hasattr(fcntl, name) for name in ('F_GET_SEALS', 'F_SEAL_WRITE', 'F_SEAL_GROW', 'F_SEAL_SHRINK', 'F_SEAL_SEAL')), 'parent_memfd_required')
            require(os.readlink(f'/proc/self/fd/{fd}') == '/memfd:paperclip-verified-launch (deleted)' and before.st_mode & 0o222 == 0, 'parent_memfd_required')
            required = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
            seals = fcntl.fcntl(fd, fcntl.F_GET_SEALS)
            require(type(seals) is int and seals & required == required, 'parent_memfd_seals')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            require(size <= 256 * 1024 * 1024, 'parent_descriptor_shape')
        require(size == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(os.stat(path)) == identity(os.stat(executable)), 'parent_descriptor_changed')
        if seals is not None:
            require(fcntl.fcntl(fd, fcntl.F_GET_SEALS) == seals, 'parent_memfd_seals')
        return b''.join(chunks), (before.st_dev, before.st_ino)
    finally:
        os.close(fd)


def checked_runner(path):
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode), 'runner_shape')
    resolved = os.path.realpath(path)
    content, inode = checked_file(resolved, 256 * 1024 * 1024)
    after = os.lstat(path)
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_mtime_ns, value.st_ctime_ns)
    require(identity(before) == identity(after) and os.path.realpath(path) == resolved, 'runner_changed')
    return content, inode


def parse_closure(content, expected):
    manifest = json.loads(content)
    entries = manifest.get('entries') if isinstance(manifest, dict) else None
    require(isinstance(entries, list) and 0 < len(entries) <= 30000, 'closure_inventory')
    normalized, previous, total = [], '', 0
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == {'path', 'sha256', 'size', 'executable'}, 'closure_shape')
        path = entry['path']
        require(isinstance(path, str) and 0 < len(path) <= 4096 and not os.path.isabs(path)
                and not re.search(r'[\x00-\x1f\x7f\\]', path) and path > previous
                and all(part not in ('', '.', '..') for part in path.split('/'))
                and path != 'manifest.json' and not path.startswith('.paperclip-'), 'closure_path')
        require(isinstance(entry['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', entry['sha256'])
                and type(entry['size']) is int and 0 <= entry['size'] <= 384 * 1024 * 1024
                and type(entry['executable']) is bool, 'closure_metadata')
        total += entry['size']
        require(total <= 1024 * 1024 * 1024, 'closure_bound')
        previous = path
        normalized.append({key: entry[key] for key in ('path', 'sha256', 'size', 'executable')})
    require(re.fullmatch(r'[a-f0-9]{64}', expected) and digest(json.dumps(normalized, separators=(',', ':'), ensure_ascii=False).encode()) == expected, 'closure_pin')
    return normalized


def expected_sources(config, distribution, entries):
    bootstrap, guard = config['bootstrapTemplate'], config['guardTemplate']
    require(isinstance(bootstrap, str) and 0 < len(bootstrap) <= 32768 and PLACEHOLDER in bootstrap, 'bootstrap_template')
    require(isinstance(guard, str) and 0 < len(guard) <= 32768 and guard.count('const digests={};') == 1, 'guard_template')
    digests = {distribution + '/' + entry['path']: entry['sha256'] for entry in entries}
    return bootstrap.replace(PLACEHOLDER, distribution).encode(), guard.replace('const digests={};', 'const digests=' + json.dumps(digests, separators=(',', ':'), ensure_ascii=False) + ';').encode()


def inspect(config):
    require(set(config) == {'root', 'binding', 'runtimeEnvironmentLeaseId', 'runnerdSha256', 'closureSha256', 'nodeSha256', 'guardLoaderSha256', 'bootstrapTemplate', 'guardTemplate'}, 'config_keys')
    require(all(isinstance(config[key], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', config[key]) for key in ('runnerdSha256', 'nodeSha256', 'guardLoaderSha256')), 'digest_shape')
    binding, expected = config['binding'], config['root']
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    require(re.fullmatch(r'[a-f0-9-]{36}', boot) and boot == expected['bootId'], 'boot_changed')
    root = proc(expected['pid'], boot)
    require(root == expected and os.getpgid(root['pid']) == root['pid'], 'root_changed')
    runtime = binding['remoteCwd'] + '/.paperclip-runtime/paperclip-runner'
    runner = runtime + '/bin/paperclip-runnerd'
    root_args = argv(root['pid'])
    require(root_args[0] == runner and flag(root_args, '--run-id') == binding['runId']
            and flag(root_args, '--environment-lease-id') == config['runtimeEnvironmentLeaseId']
            and flag(root_args, '--lifecycle-mode') == 'per_turn', 'root_binding')
    require(re.fullmatch(re.escape(runtime) + r'/sessions/[a-f0-9]{64}/runner', flag(root_args, '--state-dir')), 'root_session')
    runner_bytes, runner_inode = checked_runner(runner)
    root_exe = os.stat(f'/proc/{root["pid"]}/exe')
    require((root_exe.st_dev, root_exe.st_ino) == runner_inode and 'sha256:' + digest(runner_bytes) == config['runnerdSha256'], 'runner_executable')
    metadata, _ = checked_file(PACK + '/provider-assets/kimi/linux-x64/native-closure.json', 4 * 1024 * 1024)
    ordered_entries = parse_closure(metadata, config['closureSha256'])
    entries = {entry['path']: entry for entry in ordered_entries}
    require(NODE in entries and ENTRY in entries and entries[NODE]['executable'] and entries[NODE]['size'] > 0
            and entries[ENTRY]['size'] > 0 and 'sha256:' + entries[NODE]['sha256'] == config['nodeSha256'], 'required_entries')
    pids = [int(pid) for pid in os.listdir('/proc') if pid.isdigit() and int(pid) > 1]
    require(len(pids) <= 4096, 'process_bound')
    table = {}
    for pid in pids:
        try:
            table[pid] = proc(pid, boot)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except RuntimeError as error:
            if str(error).endswith(':dead_or_invalid_process'):
                continue
            raise

    def ancestry(pid):
        chain = []
        while pid != root['pid']:
            require(pid in table and len(chain) < 64 and pid not in [item['pid'] for item in chain], 'ancestry')
            chain.append(table[pid])
            pid = table[pid]['ppid']
        result = chain + [root]
        require(all(int(child['startTicks']) >= int(parent['startTicks']) for child, parent in zip(result, result[1:])), 'ancestry_birth')
        return result

    matches = []
    for pid in table:
        try:
            chain = ancestry(pid)
        except RuntimeError:
            continue
        if len(chain) < 3:
            continue
        parent = table[pid]['ppid']
        try:
            args = argv(parent)
        except (FileNotFoundError, ProcessLookupError):
            continue
        if len(args) != 10 or args[1] != '--eval' or args[4] != BOOTSTRAP:
            continue
        distribution = args[3]
        require(re.fullmatch(r'/tmp/paperclip-acpx-native-[A-Za-z0-9_-]+/distribution', distribution), 'snapshot_path')
        require(args[4:] == [BOOTSTRAP, '0', '0', 'commonjs', '[]', '0'] and 'sha256:' + digest(args[2].encode()) == config['guardLoaderSha256'], 'parent_bootstrap')
        require(argv(pid) == ['kimi-code'], 'native_title')
        for directory in (distribution, os.path.dirname(distribution)):
            status = os.lstat(directory)
            require(stat.S_ISDIR(status.st_mode) and not status.st_mode & 0o222 and os.path.realpath(directory) == directory, 'snapshot_seal')
        require(os.readlink(f'/proc/{pid}/cwd') == binding['remoteCwd'] and os.readlink(f'/proc/{parent}/cwd') == binding['remoteCwd'], 'cwd')
        identities = {}
        for name in (NODE, ENTRY):
            content, inode = checked_file(distribution + '/' + name, 256 * 1024 * 1024, True)
            require(len(content) == entries[name]['size'] and digest(content) == entries[name]['sha256'], 'snapshot_digest')
            identities[name] = inode
        bootstrap, guard = expected_sources(config, distribution, ordered_entries)
        require(checked_file(distribution + '/' + BOOTSTRAP, 32768, True)[0] == bootstrap, 'native_bootstrap_bytes')
        require(checked_file(distribution + '/' + GUARD, 4 * 1024 * 1024, True)[0] == guard, 'native_guard_bytes')
        native_exe, held_node = os.stat(f'/proc/{pid}/exe'), os.stat(f'/proc/{pid}/fd/7')
        require((native_exe.st_dev, native_exe.st_ino) == identities[NODE] == (held_node.st_dev, held_node.st_ino), 'native_executable')
        if args[0] == '/proc/self/fd/10':
            parent_bytes, parent_inode = checked_parent_descriptor(parent)
        else:
            parent_exe_path = os.path.realpath(f'/proc/{parent}/exe')
            parent_bytes, parent_inode = checked_file(parent_exe_path, 256 * 1024 * 1024)
        require('sha256:' + digest(parent_bytes) == config['nodeSha256'], 'parent_node')
        if args[0] != '/proc/self/fd/10':
            require(args[0] == PACK + '/node_modules/node/bin/node' and checked_file(args[0], 256 * 1024 * 1024)[1] == parent_inode, 'parent_node_path')
        directory_fd = os.stat(f'/proc/{parent}/fd/4')
        directory = os.lstat(distribution)
        require(stat.S_ISDIR(directory_fd.st_mode) and (directory_fd.st_dev, directory_fd.st_ino) == (directory.st_dev, directory.st_ino), 'parent_directory_descriptor')
        source_mode = os.stat(f'/proc/{parent}/fd/3').st_mode
        require(stat.S_ISFIFO(source_mode) or stat.S_ISSOCK(source_mode), 'parent_source_pipe')
        for identity in chain:
            require(proc(identity['pid'], boot) == identity, 'ancestry_changed')
        matches.append({'target': table[pid], 'ancestry': chain, 'nodeSha256': config['nodeSha256'],
                        'entrypointSha256': 'sha256:' + entries[ENTRY]['sha256'], 'closureSha256': config['closureSha256'],
                        'guardLoaderSha256': config['guardLoaderSha256'], 'guardSha256': 'sha256:' + digest(guard), 'bootstrapSha256': 'sha256:' + digest(bootstrap),
                        'entrypointAttribution': 'pinned_native_bootstrap_parent', 'originalChildArgvAvailable': False, 'observedChildTitle': 'kimi-code'})
    require(len(matches) == 1, 'unique_native_child')
    return matches[0]


def terminate(config):
    require(sys.platform == 'linux' and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'pidfd_required')
    before = inspect(config)
    pid = before['target']['pid']
    require(pid not in (os.getpid(), config['root']['pid']), 'not_worker')
    fd = os.pidfd_open(pid)
    try:
        require(inspect(config) == before, 'identity_changed_after_pidfd')
        fields = dict(line.split(':', 1) for line in Path(f'/proc/self/fdinfo/{fd}').read_text().splitlines() if ':' in line)
        require(int(fields.get('Pid', '-1').strip()) == pid, 'pidfd_retired')
        signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
        return {'schema': 'paperclip.e2e.kimi-provider-death.v1', 'binding': config['binding'], 'runtimeEnvironmentLeaseId': config['runtimeEnvironmentLeaseId'],
                **before, 'signalled': True, 'signal': 'SIGKILL', 'targetKind': 'kimi_native_child', 'workerSignalled': False}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2 and len(sys.argv[1]) <= 131072, 'input_bound')
        print(json.dumps(terminate(json.loads(base64.b64decode(sys.argv[1], validate=True))), separators=(',', ':')))
    except Exception:
        print(json.dumps({'ok': False, 'code': 'kimi_provider_identity_or_signal_failed'}))
        sys.exit(1)
