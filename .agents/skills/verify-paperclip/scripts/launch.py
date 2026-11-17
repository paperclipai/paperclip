#!/usr/bin/env python3
"""Run the repository's credential-free isolated foreground onboarding path."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--data-dir', required=True, type=Path)
parser.add_argument('--evidence-dir', required=True, type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[4]
data = args.data_dir.resolve()
evidence = args.evidence_dir.resolve()
if data == evidence or data in evidence.parents or evidence in data.parents:
    parser.error('Data and evidence directories must be separate.')
data.mkdir(parents=True, exist_ok=True)
evidence.mkdir(parents=True, exist_ok=True)
if any(data.iterdir()) or (evidence / 'launch.json').exists():
    parser.error('Use a fresh empty data directory and a new evidence directory.')
cli = repo / 'cli/node_modules/tsx/dist/cli.mjs'
if not cli.is_file():
    parser.error('Install checkout dependencies first: pnpm install --frozen-lockfile')
for port in range(3100, 4100):
    try:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
        break
    except OSError:
        continue
else:
    raise RuntimeError('No available verification port between 3100 and 4099.')
excluded = {'DATABASE_URL', 'DATABASE_MIGRATION_URL', 'HOST', 'PORT', 'SERVE_UI',
            'BETTER_AUTH_URL', 'BETTER_AUTH_BASE_URL', 'NODE_OPTIONS'}
env = {key: value for key, value in os.environ.items()
       if not key.startswith('PAPERCLIP_') and key not in excluded}
env.update({'PAPERCLIP_HOME': str(data), 'PAPERCLIP_INSTANCE_ID': 'default',
            'PAPERCLIP_DISABLE_CWD_ENV_FILE': 'true', 'PAPERCLIP_NO_BROWSER': 'true',
            'PAPERCLIP_OPEN_ON_LISTEN': 'false', 'PAPERCLIP_UPDATE_CHECK': '0',
            'PAPERCLIP_TELEMETRY_DISABLED': '1', 'PAPERCLIP_DEPLOYMENT_MODE': 'local_trusted',
            'PAPERCLIP_DEPLOYMENT_EXPOSURE': 'private', 'PAPERCLIP_BIND': 'loopback',
            'HOST': '127.0.0.1', 'PORT': str(port)})
record = {'dataDir': str(data), 'evidenceDir': str(evidence), 'repo': str(repo),
          'launcherPid': os.getpid(), 'port': port, 'url': f'http://127.0.0.1:{port}',
          'commit': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()}
(evidence / 'launch.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record), flush=True)
os.chdir(repo)
os.execvpe('node', ['node', str(cli), 'cli/src/index.ts', 'onboard', '--data-dir',
                   str(data), '--yes', '--bind', 'loopback', '--no-install-service', '--run'], env)
