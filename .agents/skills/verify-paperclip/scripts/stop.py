#!/usr/bin/env python3
"""Stop only an owned verification runtime and check that its database exits."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-dir', required=True, type=Path)
args = parser.parse_args()
evidence = args.evidence_dir.resolve()
launch = json.loads((evidence / 'launch.json').read_text())
repo = Path(launch['repo']).resolve()
assert repo == Path(__file__).resolve().parents[4], 'Launch belongs to another checkout.'
instance = Path(launch['dataDir']) / 'instances/default'
runtime_file = instance / 'runtime-info.json'
runtime = json.loads(runtime_file.read_text()) if runtime_file.exists() else None
pid = None
if runtime:
    assert runtime['port'] == launch['port'] and runtime['dashboardUrl'] == launch['url']
    pid = runtime['pid']
    owners = subprocess.run(['lsof', '-nP', f'-iTCP:{launch["port"]}', '-sTCP:LISTEN', '-t'], capture_output=True, text=True).stdout.split()
    assert set(owners) == {str(pid)}, 'Refusing to signal a different or unverified port owner.'
    if sys.platform == 'darwin':
        rows = subprocess.check_output(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True).splitlines()
        cwd = Path(next(row[1:] for row in rows if row.startswith('n'))).resolve()
    else:
        cwd = Path(f'/proc/{pid}/cwd').resolve(strict=True)
    assert cwd == repo or repo in cwd.parents, 'Refusing to signal another checkout.'
    ancestor = pid
    seen = set()
    while ancestor != launch['launcherPid']:
        assert ancestor > 1 and ancestor not in seen, 'Runtime is not descended from this launch.'
        seen.add(ancestor)
        ancestor = int(subprocess.check_output(['ps', '-p', str(ancestor), '-o', 'ppid='], text=True).strip())
    os.kill(pid, signal.SIGTERM)
def runtime_exited():
    if pid is None:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    # An exited child can remain a zombie until its launcher reaps it.
    state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='],
                           capture_output=True, text=True)
    return state.returncode == 0 and state.stdout.strip().startswith('Z')


deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    owners = subprocess.run(['lsof', '-nP', f'-iTCP:{launch["port"]}', '-sTCP:LISTEN', '-t'], capture_output=True, text=True).stdout.split()
    if not owners and not (instance / 'db/postmaster.pid').exists() and runtime_exited():
        result = {'status': 'passed', 'port': launch['port'], 'serverStopped': True,
                  'databaseStopped': True, 'runtimeExited': True, 'evidenceRetained': sorted(p.name for p in evidence.iterdir())}
        (evidence / 'cleanup.json').write_text(json.dumps(result, indent=2) + '\n')
        print(f'PASS: owned runtime/database stopped; evidence retained at {evidence}.')
        break
    time.sleep(0.5)
else:
    raise SystemExit('Shutdown incomplete; retain data and evidence and inspect only this owned instance.')
