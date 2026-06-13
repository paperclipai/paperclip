# n8n_health.py
"""Read-only n8n-Health-/Env-Diagnose für die Fehlerklassifikation."""
from __future__ import annotations

import urllib.request

_FLAGS = ("N8N_BLOCK_ENV_ACCESS_IN_NODE", "NODE_FUNCTION_ALLOW_BUILTIN")


def parse_env_flags(ps_output: str) -> dict:
    """Sucht die relevanten Flags als FLAG=value-Token im (ps eww)-Text.
    Nicht gefunden → None."""
    out = {f: None for f in _FLAGS}
    for token in (ps_output or "").split():
        for flag in _FLAGS:
            if token.startswith(flag + "="):
                out[flag] = token.split("=", 1)[1]
    return out


def healthz(base: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base}/healthz", timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception:  # noqa: BLE001
        return False
