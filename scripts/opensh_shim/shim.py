"""OpenShell 0.0.47 runner for the enrichment dispatcher.

Enabled execution uses one fresh sandbox per invocation and only the supported
``sandbox create/upload/exec/delete`` commands.  Secrets are carried in a
mode-0600 uploaded envelope, never in a command argument.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Mapping

from .config import ShimConfig

ENV_ALLOWLIST = (
    "PATH", "DATABASE_URL", "ENRICHMENT_COMPANY_ID", "ENRICHMENT_BATCH_SIZE",
    "ENRICHMENT_DISPATCHER_CONCURRENCY", "LITELLM_BASE_URL", "LITELLM_API_KEY",
    "ANTHROPIC_API_KEY", "PAPERCLIP_API_URL", "PAPERCLIP_API_KEY",
    "PAPERCLIP_ROUTINE_ID", "ENRICHMENT_ISSUE_ID", "PAPERCLIP_RUN_ID",
    "PAPERCLIP_TASK_ID", "ENRICHMENT_ESCALATION_ASSIGNEE_ID",
)


def allowlisted_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return present string values only; this is the whole runtime envelope."""
    source = os.environ if env is None else env
    return {key: value for key in ENV_ALLOWLIST if isinstance((value := source.get(key)), str) and value}


def _ignore_copy(_: str, names: list[str]) -> set[str]:
    return {
        name for name in names
        if name in {".git", ".env", "__pycache__", "node_modules", ".pytest_cache"}
        or name.endswith((".pyc", ".pyo"))
    }


def _stage_source(source_root: Path, env: Mapping[str, str]) -> tempfile.TemporaryDirectory[str]:
    """Make a local, automatically cleaned mirror containing only remote inputs."""
    stage = tempfile.TemporaryDirectory(prefix="opensh-enrichment-")
    stage_root = Path(stage.name)
    for relative in ("enrichment", "pilot-artifacts", "scripts/opensh_shim"):
        src = source_root / relative
        if not src.is_dir():
            stage.cleanup()
            raise RuntimeError(f"OpenShell source mirror missing required path: {relative}")
        destination = stage_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, destination, ignore=_ignore_copy)
    runtime_dir = stage_root / ".opensh"
    runtime_dir.mkdir(mode=0o700)
    runtime = runtime_dir / "runtime.json"
    runtime.write_text(json.dumps(allowlisted_env(env), sort_keys=True), encoding="utf-8")
    runtime.chmod(0o600)
    return stage


class OpenShellShim:
    def __init__(self, cfg: ShimConfig) -> None:
        self._cfg = cfg

    def run(
        self,
        cmd: list[str],
        *,
        timeout: float = 900.0,
        cwd: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        **kwargs,
    ) -> subprocess.CompletedProcess:
        if not self._cfg.enabled:
            return subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout,
                cwd=cwd, env=allowlisted_env(env), **kwargs,
            )
        if not self._cfg.sandbox_image:
            raise RuntimeError("OPENSH_SANDBOX_IMAGE is required when OpenShell is enabled")
        if cwd is None:
            raise RuntimeError("enabled OpenShell execution requires an explicit source root")

        source_root = Path(cwd).resolve()
        sandbox_name = f"enrichment-{uuid.uuid4().hex}"
        created = False
        stage = _stage_source(source_root, env or os.environ)
        try:
            create = subprocess.run(
                ["openshell", "sandbox", "create", "--name", sandbox_name,
                 "--from", self._cfg.sandbox_image, "--no-tty"],
                capture_output=True, text=True, timeout=60,
            )
            if create.returncode:
                return create
            created = True
            upload = subprocess.run(
                ["openshell", "sandbox", "upload", "--no-git-ignore", sandbox_name,
                 stage.name, self._cfg.workdir],
                capture_output=True, text=True, timeout=120,
            )
            if upload.returncode:
                return upload
            return subprocess.run(
                ["openshell", "sandbox", "exec", "--name", sandbox_name,
                 "--workdir", self._cfg.workdir, "--timeout", str(int(timeout)), "--no-tty", "--",
                 "python3", "-m", "scripts.opensh_shim.remote_dispatcher"],
                capture_output=True, text=True, timeout=timeout + 30,
            )
        finally:
            stage.cleanup()
            if created:
                delete = subprocess.run(
                    ["openshell", "sandbox", "delete", sandbox_name],
                    capture_output=True, text=True, timeout=60,
                )
                if delete.returncode:
                    raise RuntimeError("OpenShell sandbox deletion failed")
