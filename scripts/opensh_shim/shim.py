"""
Main OpenShell shim — platform-aware routing.

Linux: uses Landlock-backed OpenShell sandbox via gRPC or CLI dispatcher.
macOS: OPENSH_MACOS_FALLBACK=container routes to Docker container (no native Landlock).
       OPENSH_MACOS_FALLBACK=none runs unsandboxed (logs a warning).

Usage:
    cfg = ShimConfig.from_env()
    shim = OpenShellShim(cfg, pool)

    # As a drop-in for subprocess.run:
    result = shim.run(["python3", "script.py", "--arg", "value"], timeout=30.0)
"""
from __future__ import annotations

import logging
import platform
import subprocess

from .config import ShimConfig
from .pool import SandboxPool

logger = logging.getLogger(__name__)


class OpenShellShim:
    """
    Sandbox-aware drop-in for subprocess.run.

    When cfg.enabled is False (OPENSH_SANDBOX_ENABLED=0), delegates
    directly to subprocess.run with no overhead.
    """

    def __init__(self, cfg: ShimConfig, pool: SandboxPool | None = None) -> None:
        self._cfg = cfg
        self._pool = pool
        self._is_macos = platform.system() == "Darwin"

    def run(
        self,
        cmd: list[str],
        *,
        timeout: float = 60.0,
        **kwargs,
    ) -> subprocess.CompletedProcess:
        """
        Execute cmd, optionally sandboxed.

        Extra kwargs (cwd, env, stdin, etc.) are forwarded when running
        unsandboxed.  The sandboxed path uses the shim dispatcher and
        ignores most kwargs — callers should pre-set env inside the sandbox.
        """
        if not self._cfg.enabled:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kwargs)

        if self._is_macos:
            return self._run_macos(cmd, timeout=timeout, **kwargs)

        return self._run_sandboxed(cmd, timeout=timeout)

    # ------------------------------------------------------------------
    # Linux sandboxed path
    # ------------------------------------------------------------------

    def _run_sandboxed(self, cmd: list[str], *, timeout: float) -> subprocess.CompletedProcess:
        if self._pool is None:
            raise RuntimeError("OpenShell pool not initialized — call SandboxPool.prefill() first")

        with self._pool.acquire() as sandbox_name:
            if self._cfg.use_grpc:
                from . import dispatcher_grpc
                return dispatcher_grpc.exec_in_sandbox(sandbox_name, cmd, timeout=timeout)
            else:
                from . import dispatcher_cli
                return dispatcher_cli.exec_in_sandbox(sandbox_name, cmd, timeout=timeout)

    # ------------------------------------------------------------------
    # macOS paths
    # ------------------------------------------------------------------

    def _run_macos(self, cmd: list[str], *, timeout: float, **kwargs) -> subprocess.CompletedProcess:
        if self._cfg.macos_fallback == "container":
            return self._run_container_fallback(cmd, timeout=timeout)
        else:
            # macos_fallback=none — run unsandboxed, log warning
            logger.warning(
                "OpenShell: macOS host with OPENSH_MACOS_FALLBACK=none — "
                "running unsandboxed (no native Landlock)"
            )
            return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kwargs)

    def _run_container_fallback(self, cmd: list[str], *, timeout: float) -> subprocess.CompletedProcess:
        """
        Run cmd inside a Docker container on macOS.

        Uses the same openshell image (tag=OPENSH_SANDBOX_TAG) so the execution
        environment matches Linux production. Docker Desktop / OrbStack required.
        """
        docker_cmd = [
            "docker", "run", "--rm",
            "--label", "openshell.ai/sandbox-pool=true",
            f"openshell/sandbox:{self._cfg.sandbox_tag}",
        ] + cmd
        return subprocess.run(docker_cmd, capture_output=True, text=True, timeout=timeout + 10.0)
