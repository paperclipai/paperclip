# n8n_rest.py
"""Dünner, stdlib-only Client für die n8n Public REST API v1 (2.25.7)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:5678"


class N8nApiError(RuntimeError):
    pass


def load_api_key(env_file: str | None = None) -> str:
    """N8N_API_KEY aus der Umgebung, sonst aus ~/.whitestag.env.
    Akzeptiert sowohl `N8N_API_KEY=...` als auch `export N8N_API_KEY=...`."""
    val = os.environ.get("N8N_API_KEY")
    if val:
        return val
    env_file = env_file or os.path.expanduser("~/.whitestag.env")
    try:
        with open(env_file) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("export "):
                    line = line[len("export "):].lstrip()
                if line.startswith("N8N_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return ""
    return ""


def _request(method: str, url: str, key: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", "X-N8N-API-KEY": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8") or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise N8nApiError(f"HTTP {e.code} for {method} {url}") from e
    except Exception as e:  # noqa: BLE001
        raise N8nApiError(f"request failed for {method} {url}: {e}") from e


def get_workflow(base: str, key: str, wf_id: str) -> dict:
    return _request("GET", f"{base}/api/v1/workflows/{wf_id}", key)


def activate_workflow(base: str, key: str, wf_id: str) -> dict:
    return _request("POST", f"{base}/api/v1/workflows/{wf_id}/activate", key, payload={})


def deactivate_workflow(base: str, key: str, wf_id: str) -> dict:
    return _request("POST", f"{base}/api/v1/workflows/{wf_id}/deactivate", key, payload={})


def retry_execution(base: str, key: str, exec_id: str, load_workflow: bool = False) -> dict:
    return _request("POST", f"{base}/api/v1/executions/{exec_id}/retry", key,
                    payload={"loadWorkflow": load_workflow})
