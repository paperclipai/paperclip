"""CLI exec dispatcher — wraps 'openshell exec <sandbox> <cmd>'."""
from __future__ import annotations

import subprocess


def exec_in_sandbox(sandbox_name: str, cmd: list[str], timeout: float = 60.0) -> subprocess.CompletedProcess:
    """
    Run cmd inside sandbox_name via the 'openshell exec' CLI.

    Measured overhead: +210.8 ms mean vs direct subprocess (SAG-2280 canary).
    Prefer dispatcher_grpc.exec_in_sandbox() for production (-24% latency).
    """
    full_cmd = ["openshell", "exec", sandbox_name, "--"] + cmd
    return subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout)
