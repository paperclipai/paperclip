#!/usr/bin/env python3
"""Tinker readiness diagnostics (judgment-loop Slice A).

Local, bounded, secret-safe probe of the Tinker (Thinking Machines) SDK/service:

- reads TINKER_API_KEY only from the environment or TINKER_CREDENTIAL_CMD,
- prints SDK version, ServiceClient surface, and billing/capability status,
- redacts any secret material from all output and artifacts,
- bounds the capability probe with a hard subprocess timeout so SDK-internal
  retry loops (observed on HTTP 402) cannot stall the caller,
- writes a safe JSON readiness artifact to
  /root/cps/var/toolbelt/tinker/READINESS.json.

No training or sampling job is ever launched. No paid action is taken.
Exit code 0 = diagnostics ran and artifact written (whatever the service said);
non-zero only for local failures (SDK missing, artifact unwritable).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ARTIFACT_PATH = Path('/root/cps/var/toolbelt/tinker/READINESS.json')
PROBE_TIMEOUT_S = 25

# Child process source: constructs ServiceClient and calls get_server_capabilities().
# Runs isolated so the parent can enforce a hard wall-clock bound. The key reaches
# the child via environment only — never argv, never stdout.
_PROBE_SOURCE = r'''
import json, sys
out = {"ok": False, "error": None, "capabilities_summary": None}
try:
    from tinker import ServiceClient
    client = ServiceClient(user_metadata={"purpose": "readiness-diagnostics"})
    caps = client.get_server_capabilities()
    models = getattr(caps, "supported_models", None)
    out["ok"] = True
    out["capabilities_summary"] = {
        "type": type(caps).__name__,
        "supported_model_count": len(models) if models is not None else None,
        "supported_models_head": [str(getattr(m, "model_name", m)) for m in (models or [])][:10],
    }
except Exception as exc:
    out["error"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(out))
'''


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def redact(text: str, secrets: list[str]) -> str:
    for s in secrets:
        if s:
            text = text.replace(s, '***REDACTED***')
    return text


def resolve_api_key() -> tuple[str | None, str]:
    """Return (key, source). Only env and TINKER_CREDENTIAL_CMD are consulted."""
    key = os.environ.get('TINKER_API_KEY', '').strip()
    if key:
        return key, 'env:TINKER_API_KEY'
    cred_cmd = os.environ.get('TINKER_CREDENTIAL_CMD', '').strip()
    if cred_cmd:
        try:
            proc = subprocess.run(
                cred_cmd, shell=True, capture_output=True, text=True, timeout=10,
            )
            key = proc.stdout.strip()
            if proc.returncode == 0 and key:
                return key, 'credential_cmd:TINKER_CREDENTIAL_CMD'
            return None, f'credential_cmd_failed:rc={proc.returncode}'
        except subprocess.TimeoutExpired:
            return None, 'credential_cmd_timeout'
    return None, 'absent'


def inspect_sdk() -> dict:
    import tinker
    from tinker import ServiceClient
    methods = sorted(
        name for name in dir(ServiceClient)
        if not name.startswith('_') and callable(getattr(ServiceClient, name, None))
    )
    return {
        'sdk_version': getattr(tinker, '__version__', 'unknown'),
        'service_client_methods': methods,
        'base_url_override': os.environ.get('TINKER_BASE_URL') or None,
    }


def classify_probe(probe: dict) -> str:
    if probe.get('ok'):
        return 'ready'
    err = (probe.get('error') or '').lower()
    if '402' in err or 'billing' in err or 'payment' in err:
        return 'billing_blocked'
    if '401' in err or 'unauthorized' in err or 'unauthenticated' in err or 'authentication' in err:
        return 'auth_failed'
    if probe.get('timed_out'):
        return 'timeout_bounded'
    return 'error'


def run_probe(api_key: str, timeout_s: int, secrets: list[str]) -> dict:
    env = dict(os.environ)
    env['TINKER_API_KEY'] = api_key
    try:
        proc = subprocess.run(
            [sys.executable, '-c', _PROBE_SOURCE],
            capture_output=True, text=True, timeout=timeout_s, env=env,
        )
    except subprocess.TimeoutExpired:
        return {
            'ok': False, 'timed_out': True,
            'error': f'capability probe exceeded {timeout_s}s hard bound '
                     '(SDK retry loop bounded by design; observed on HTTP 402)',
        }
    stdout = redact(proc.stdout.strip(), secrets)
    try:
        probe = json.loads(stdout.splitlines()[-1]) if stdout else {}
    except (json.JSONDecodeError, IndexError):
        probe = {'ok': False, 'error': f'unparseable probe output: {stdout[:500]}'}
    if proc.returncode != 0 and not probe.get('error'):
        probe['ok'] = False
        probe['error'] = redact(proc.stderr.strip()[:500], secrets)
    if probe.get('error'):
        probe['error'] = redact(str(probe['error']), secrets)
    probe['timed_out'] = probe.get('timed_out', False)
    return probe


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Tinker readiness diagnostics (secret-safe, bounded).')
    parser.add_argument('--timeout', type=int, default=PROBE_TIMEOUT_S,
                        help=f'hard wall-clock bound for the capability probe (default {PROBE_TIMEOUT_S}s)')
    parser.add_argument('--artifact', default=str(ARTIFACT_PATH),
                        help=f'readiness artifact path (default {ARTIFACT_PATH})')
    parser.add_argument('--no-probe', action='store_true',
                        help='inspect SDK only; skip the network capability probe')
    args = parser.parse_args(argv)

    report: dict = {
        'schema': 'cps.tinker_readiness.v1',
        'checked_utc': utc_now(),
        'probe_timeout_s': args.timeout,
        'network_probe_attempted': False,
        'paid_actions': False,
        'jobs_launched': False,
    }

    try:
        report['sdk'] = inspect_sdk()
        report['sdk_importable'] = True
    except Exception as exc:
        report['sdk_importable'] = False
        report['sdk'] = {'error': f'{type(exc).__name__}: {exc}'}
        report['status'] = 'sdk_missing'

    api_key, key_source = resolve_api_key()
    secrets = [api_key] if api_key else []
    report['api_key_present'] = bool(api_key)
    report['api_key_source'] = key_source

    if report.get('status') != 'sdk_missing':
        if not api_key:
            report['status'] = 'no_api_key'
            report['note'] = ('Supply TINKER_API_KEY via environment or TINKER_CREDENTIAL_CMD. '
                              'Keys are never persisted by this tool.')
        elif args.no_probe:
            report['status'] = 'sdk_ok_probe_skipped'
        else:
            report['network_probe_attempted'] = True
            probe = run_probe(api_key, args.timeout, secrets)
            report['probe'] = probe
            report['status'] = classify_probe(probe)

    artifact = Path(args.artifact)
    artifact.parent.mkdir(parents=True, exist_ok=True)
    payload = redact(json.dumps(report, indent=2, sort_keys=True) + '\n', secrets)
    artifact.write_text(payload)
    report['artifact_path'] = str(artifact)

    print(redact(json.dumps(report, indent=2, sort_keys=True), secrets))
    return 0


if __name__ == '__main__':
    sys.exit(main())
