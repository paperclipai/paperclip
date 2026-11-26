"""One explicitly authorized, owned initdb bootstrap diagnostic; no server/model/case.
Raw stderr remains private. Never stops unrelated processes or removes host IPC.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import stat
import subprocess
import tempfile
import time

SNAPSHOT = pathlib.Path('/private/tmp/paperclip-chat-candidate-0fdcb539a8')
PACKAGE = 'node_modules/.pnpm/@embedded-postgres+darwin-arm64@18.1.0-beta.16/node_modules/@embedded-postgres/darwin-arm64'
BINARY = SNAPSHOT / PACKAGE / 'native/bin/initdb'
PREFIX = 'paperclip-chat-initdb-diagnostic-'


def sha(filename):
    return hashlib.sha256(pathlib.Path(filename).read_bytes()).hexdigest()


def private_json(filename, value):
    with os.fdopen(os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        json.dump(value, output, indent=2)
        output.write('\n')


def validate(binary, digest, root, token):
    binary, root = pathlib.Path(binary), pathlib.Path(root)
    if binary != BINARY or binary.resolve(strict=True) != BINARY or sha(binary) != digest:
        raise ValueError('Unverified embedded initdb executable')
    parent = pathlib.Path('/private/tmp').resolve()
    if root.parent != parent or not root.name.startswith(PREFIX) or root.is_symlink():
        raise ValueError('Wrong owned diagnostic root')
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Unsafe diagnostic root ownership')
    marker = root / 'owner.json'
    mark_info = marker.lstat()
    if marker.is_symlink() or mark_info.st_uid != os.getuid() or stat.S_IMODE(mark_info.st_mode) != 0o600:
        raise ValueError('Unsafe owner marker')
    value = json.loads(marker.read_text())
    if value != {'version': 1, 'creatorPid': os.getpid(), 'uid': os.getuid(), 'token': token}:
        raise ValueError('Diagnostic ownership receipt mismatch')
    return root / 'pgdata'


def group_members(group):
    rows = []
    output = subprocess.check_output(['ps', '-axo', 'uid=,pid=,ppid=,pgid=,comm='], text=True)
    for line in output.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) == 5 and int(parts[3]) == group:
            rows.append({'uid': int(parts[0]), 'pid': int(parts[1]), 'parentPid': int(parts[2]), 'group': int(parts[3]), 'executable': parts[4]})
    return rows


def verify_members(rows):
    for row in rows:
        path = pathlib.Path(row['executable'])
        if row['uid'] != os.getuid() or path.parent != BINARY.parent or path.name not in ['initdb', 'postgres']:
            raise RuntimeError('Owned diagnostic process group cannot be safely verified')


def record_members(members, observed, ownership_findings):
    observed.update({row['pid']: row for row in members})
    try:
        verify_members(members)
    except RuntimeError:
        ownership_findings.append('Process-group member failed strict executable ownership guard')


def cause(stderr, password):
    lines = [line.replace(password, '[REDACTED]') for line in stderr.splitlines()
             if re.search(r'FATAL:|PANIC:|ERROR:|initdb: error:|could not|No space left|Invalid argument', line, re.I)]
    return lines[:10]


def run(expected_digest):
    # Actual profile credentials and the campaign oracle key are never inherited.
    original = SNAPSHOT.parent / 'paperclip-chat-candidate-e652b0de6e' / PACKAGE / 'native/bin/initdb'
    if sha(original) != expected_digest or sha(BINARY) != expected_digest:
        raise ValueError('Immutable dependency binary receipts differ')
    version = subprocess.check_output([str(BINARY), '--version'], text=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}).strip()
    root = pathlib.Path(tempfile.mkdtemp(prefix=PREFIX, dir='/private/tmp'))
    token = secrets.token_hex(24)
    private_json(root / 'owner.json', {'version': 1, 'creatorPid': os.getpid(), 'uid': os.getuid(), 'token': token})
    data = validate(BINARY, expected_digest, root, token)
    if data.exists():
        raise ValueError('Diagnostic cluster must not exist before admission')
    password = secrets.token_urlsafe(32)
    password_file = root / 'password'
    with os.fdopen(os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write(password + '\n')
    arguments = [str(BINARY), '--pgdata=' + str(data), '--auth=password', '--username=paperclip', '--pwfile=' + str(password_file), '--lc-messages=C', '--encoding=UTF8', '--locale=C', '--lc-messages=C']
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    observed = {}
    timed_out = False
    ownership_findings = []
    with os.fdopen(os.open(root / 'stdout.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stdout, os.fdopen(os.open(root / 'stderr.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stderr:
        child = subprocess.Popen(arguments, stdout=stdout, stderr=stderr, start_new_session=True,
                                 env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LC_MESSAGES': 'C', 'HOME': str(root), 'TMPDIR': str(root)})
        print(json.dumps({"phase": "owned-bootstrap-started", "pid": child.pid, "privateRoot": str(root)}), flush=True)
        deadline = time.monotonic() + 60
        while child.poll() is None:
            members = group_members(child.pid)
            # Never lose stderr/status or signal an unverified transient member.
            record_members(members, observed, ownership_findings)
            if time.monotonic() > deadline:
                timed_out = True
                # The private session was created by this Popen. Verify all current
                # members before either signal; never signal an unverified group.
                try:
                    verify_members(group_members(child.pid))
                except RuntimeError:
                    ownership_findings.append('Unverified group at deadline; only direct owned child may be stopped')
                if ownership_findings:
                    child.terminate()
                else:
                    os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if ownership_findings:
                        child.kill()
                    else:
                        verify_members(group_members(child.pid))
                        os.killpg(child.pid, signal.SIGKILL)
                break
            time.sleep(0.05)
        exit_code = child.wait(timeout=5)
    remaining = group_members(child.pid)
    if remaining:
        ownership_findings.append('Diagnostic process group still has participants; cluster/password retained')
    validate(BINARY, expected_digest, root, token)
    stderr_text = (root / 'stderr.log').read_text(errors='replace')
    # Only this freshly allocated marker-bound cluster is eligible for removal.
    if data.is_symlink():
        raise RuntimeError('Diagnostic pgdata became a symlink; root retained')
    if not remaining:
        if data.exists():
            shutil.rmtree(data)
        password_file.unlink()
    receipt = {'schema': 'paperclip.initdb-infrastructure-diagnostic/v1', 'infrastructureOnly': True,
               'canonicalAttempts': 0, 'providerCalls': 0, 'nativeRuns': 0, 'sourceSnapshot': str(SNAPSHOT),
               'binary': str(BINARY), 'binarySha256': expected_digest, 'binaryVersion': version,
               'helperSha256': sha(__file__), 'packageVersion': json.loads((SNAPSHOT / PACKAGE / 'package.json').read_text())['version'],
               'command': arguments, 'startedAt': started, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'pid': child.pid, 'processGroup': child.pid, 'observedOwnedProcesses': list(observed.values()),
               'exitCode': exit_code, 'timedOut': timed_out, 'ownershipGuardFindings': sorted(set(ownership_findings)), 'stderrSha256': sha(root / 'stderr.log'),
               'stdoutSha256': sha(root / 'stdout.log'), 'sanitizedCause': cause(stderr_text, password),
               'cleanup': {'ownedProcessGroupEmpty': not remaining, 'ownedClusterDataRemoved': not data.exists(), 'passwordFileRemoved': not password_file.exists(), 'diagnosticLogsRetainedPrivately': True}}
    private_json(root / 'receipt.json', receipt)
    return {'receiptPath': str(root / 'receipt.json'), 'exitCode': exit_code, 'sanitizedCause': receipt['sanitizedCause'], 'cleanup': receipt['cleanup']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.expected_sha256)))
