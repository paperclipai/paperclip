#!/usr/bin/env python3
"""Read-only identity and readiness check for an owned verification launch."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-dir', required=True, type=Path)
args = parser.parse_args()
evidence = args.evidence_dir.resolve()
try:
    launch = json.loads((evidence / 'launch.json').read_text())
    repo = Path(launch['repo']).resolve()
    assert repo == Path(__file__).resolve().parents[4], 'Launch belongs to another checkout.'
    runtime = json.loads((Path(launch['dataDir']) / 'instances/default/runtime-info.json').read_text())
    assert runtime['dashboardUrl'] == launch['url'], 'Runtime URL changed.'
    assert runtime['port'] == launch['port'], 'Runtime port changed.'
    assert runtime['host'] == '127.0.0.1', 'Expected trusted loopback.'
    pid = runtime['pid']
    os.kill(pid, 0)
    listeners = subprocess.check_output(['lsof', '-nP', f'-iTCP:{launch["port"]}',
                                         '-sTCP:LISTEN', '-t'], text=True).split()
    assert set(listeners) == {str(pid)}, 'Port owner does not match runtime PID.'
    if sys.platform == 'darwin':
        rows = subprocess.check_output(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True).splitlines()
        cwd = Path(next(row[1:] for row in rows if row.startswith('n'))).resolve()
    else:
        cwd = Path(f'/proc/{pid}/cwd').resolve(strict=True)
    assert cwd == repo or repo in cwd.parents, 'Port owner cwd belongs to another checkout.'
    ancestor = pid
    seen = set()
    while ancestor != launch['launcherPid']:
        assert ancestor > 1 and ancestor not in seen, 'Runtime is not descended from this launch.'
        seen.add(ancestor)
        ancestor = int(subprocess.check_output(['ps', '-p', str(ancestor), '-o', 'ppid='], text=True).strip())
    config = json.loads((Path(launch['dataDir']) / 'instances/default/config.json').read_text())
    assert config['database']['mode'] == 'embedded-postgres', 'Expected isolated embedded database.'
    assert Path(config['database']['embeddedPostgresDataDir']).resolve().is_relative_to(Path(launch['dataDir'])), 'Database path escaped isolation.'
    with urllib.request.urlopen(launch['url'] + '/api/health', timeout=15) as response:
        health = json.load(response)
    assert health['status'] == 'ok' and health['bootstrapStatus'] == 'ready', 'Instance is not ready.'
    assert health['deploymentMode'] == 'local_trusted' and health['authReady'], 'Unexpected auth mode.'
    commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    assert health['commit'] == launch['commit'] == commit, 'Served commit differs from checkout/launch.'
    with urllib.request.urlopen(launch['url'], timeout=15) as response:
        assert response.status == 200 and 'text/html' in response.headers.get('Content-Type', ''), 'Root UI is unavailable.'
    with urllib.request.urlopen(launch['url'] + '/api/companies', timeout=15) as response:
        companies = json.load(response)
    assert isinstance(companies, list), 'Board company access failed.'
    result = {'status': 'passed', 'pid': pid, 'cwd': str(cwd), 'url': launch['url'],
              'health': health, 'companyIds': [company['id'] for company in companies]}
    (evidence / 'doctor.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f'PASS: owned PID {pid}, {launch["url"]}, commit {commit}, ready board UI/API.')
except Exception as error:
    (evidence / 'doctor-failure.json').write_text(json.dumps({'status': 'failed', 'error': str(error)}, indent=2) + '\n')
    raise SystemExit(f'Doctor failed: {error}')
