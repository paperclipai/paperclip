"""Remote OpenShell bootstrap. It consumes and unlinks the runtime envelope."""
from __future__ import annotations

import json
import os
from pathlib import Path

from .shim import ENV_ALLOWLIST

RUNTIME_PATH = Path("/workspace/enrichment-stack/.opensh/runtime.json")


def main() -> None:
    try:
        raw = json.loads(RUNTIME_PATH.read_text(encoding="utf-8"))
    finally:
        # Do not leave secrets in the remote filesystem after process launch.
        RUNTIME_PATH.unlink(missing_ok=True)
    if not isinstance(raw, dict) or any(key not in ENV_ALLOWLIST or not isinstance(value, str) for key, value in raw.items()):
        raise RuntimeError("invalid OpenShell runtime envelope")
    os.execvpe("python3", ["python3", "-m", "enrichment.dispatcher"], raw)


if __name__ == "__main__":
    main()
