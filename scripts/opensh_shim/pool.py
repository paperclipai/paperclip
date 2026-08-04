"""
OpenShell sandbox pool — pre-warms OPENSH_POOL_SIZE sandboxes at startup.

Pool prefill time: ~601 ms (measured in SAG-2294).
Assignment p99 latency: 0 ms when pool is warm (12/12 warm in SAG-2294).
"""
from __future__ import annotations

import logging
import re
import subprocess
import time
import uuid
from contextlib import contextmanager
from threading import Lock
from typing import Generator

logger = logging.getLogger(__name__)

_MIB = 1024 * 1024


def _run(cmd: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


class SandboxPool:
    """
    Manages a pool of pre-warmed OpenShell sandboxes.

    Sandboxes are created with 'openshell sandbox create' and assigned
    to callers via the context-manager acquire().  After use the sandbox
    is destroyed and a fresh one is pre-warmed in its place so the pool
    stays at self._size.
    """

    def __init__(self, tag: str, size: int) -> None:
        self._tag = tag
        self._size = size
        self._available: list[str] = []
        self._lock = Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def prefill(self) -> None:
        """Create _size sandboxes synchronously.  Called once at startup."""
        t0 = time.monotonic()
        for _ in range(self._size):
            name = self._create_one()
            if name:
                with self._lock:
                    self._available.append(name)
        elapsed_ms = (time.monotonic() - t0) * 1000
        logger.info(
            "OpenShell pool prefilled: size=%d tag=%s elapsed=%.0f ms",
            len(self._available),
            self._tag,
            elapsed_ms,
        )

    def teardown(self) -> None:
        """Destroy all sandboxes in the pool."""
        with self._lock:
            names = list(self._available)
            self._available.clear()
        for name in names:
            self._destroy_one(name)

    # ------------------------------------------------------------------
    # Acquire / release
    # ------------------------------------------------------------------

    @contextmanager
    def acquire(self) -> Generator[str, None, None]:
        """
        Yield a sandbox name. After the context exits the sandbox is
        destroyed and a replacement is spawned asynchronously.
        """
        name = self._pop()
        try:
            yield name
        finally:
            self._destroy_one(name)
            new_name = self._create_one()
            if new_name:
                with self._lock:
                    self._available.append(new_name)

    # ------------------------------------------------------------------
    # Metrics
    # ------------------------------------------------------------------

    def pool_ram_mib(self) -> float:
        """
        Return total RAM used by all pool containers in MiB.

        Uses 'docker stats --no-stream --filter label=openshell.ai/sandbox-pool=true'
        to read live container memory.  Returns 0.0 if docker is unavailable or
        no containers are running.

        SAG-2294 measured ~14 MiB per idle sandbox → ~42 MiB for pool=3.
        Alert threshold: >200 MiB total (5× measured floor).
        """
        try:
            result = _run(
                [
                    "docker", "stats", "--no-stream", "--no-trunc",
                    "--format", "{{.MemUsage}}",
                    "--filter", "label=openshell.ai/sandbox-pool=true",
                ],
                timeout=5.0,
            )
            if result.returncode != 0 or not result.stdout.strip():
                return 0.0
            total = 0.0
            for line in result.stdout.strip().splitlines():
                # Format: "14.2MiB / 122.8GiB"
                m = re.match(r"([\d.]+)([KMG]iB)", line.split("/")[0].strip())
                if not m:
                    continue
                val, unit = float(m.group(1)), m.group(2)
                if unit == "KiB":
                    total += val / 1024
                elif unit == "MiB":
                    total += val
                elif unit == "GiB":
                    total += val * 1024
            return total
        except Exception as exc:
            logger.debug("pool_ram_mib: docker stats failed: %s", exc)
            return 0.0

    def size(self) -> int:
        with self._lock:
            return len(self._available)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _create_one(self) -> str | None:
        name = f"sage-pool-{uuid.uuid4().hex[:8]}"
        result = _run(
            ["openshell", "sandbox", "create", "--tag", self._tag,
             "--label", "openshell.ai/sandbox-pool=true",
             "--name", name],
            timeout=30.0,
        )
        if result.returncode != 0:
            logger.warning("openshell sandbox create failed: %s", result.stderr.strip())
            return None
        return name

    def _destroy_one(self, name: str) -> None:
        result = _run(["openshell", "sandbox", "destroy", name], timeout=10.0)
        if result.returncode != 0:
            logger.debug("openshell sandbox destroy %s: %s", name, result.stderr.strip())

    def _pop(self) -> str:
        with self._lock:
            if self._available:
                return self._available.pop(0)
        # Cold start — pool exhausted or not prefilled
        logger.warning("OpenShell pool empty — cold-starting sandbox (~600 ms)")
        name = self._create_one()
        if not name:
            raise RuntimeError("OpenShell: failed to create sandbox (pool empty and cold-start failed)")
        return name
