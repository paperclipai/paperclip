"""
Pool warm-up measurement CLI — used for SAG-2293 gate prep.

Usage:
    OPENSH_SANDBOX_ENABLED=1 OPENSH_SANDBOX_TAG=0.0.47 \\
      python3 -m scripts.opensh_shim.measure_pool --pool-size 3 --tasks 12

Outputs a JSON report with:
  - per-sandbox idle RAM/CPU (via docker stats --filter label)
  - pool prefill time
  - assignment latency (p50/p95/p99)
  - per-exec shim overhead vs direct subprocess

SAG-2294 bug note: original _live_sandbox_stats() used wrong container name
pattern.  This version uses 'label=openshell.ai/sandbox-pool=true' filter
which correctly finds pool containers regardless of name format.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from statistics import mean, median, quantiles

# Allow running as both module and script
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from scripts.opensh_shim.config import ShimConfig  # type: ignore[import]
from scripts.opensh_shim.pool import SandboxPool  # type: ignore[import]

logger = logging.getLogger(__name__)
_DUMMY_CMD = ["true"]


def _live_sandbox_stats() -> dict[str, float]:
    """
    Read RAM/CPU for all pool containers via docker stats.

    Fixes SAG-2294 bug: uses --filter label=openshell.ai/sandbox-pool=true
    instead of matching on container short-name.
    """
    import re

    result = subprocess.run(
        [
            "docker", "stats", "--no-stream", "--no-trunc",
            "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}",
            "--filter", "label=openshell.ai/sandbox-pool=true",
        ],
        capture_output=True,
        text=True,
        timeout=10.0,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return {}

    stats: dict[str, float] = {}
    for line in result.stdout.strip().splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        name = parts[0].strip()
        mem_str = parts[1].split("/")[0].strip()
        cpu_str = parts[2].strip().rstrip("%")

        m = re.match(r"([\d.]+)([KMG]iB)", mem_str)
        if not m:
            continue
        val, unit = float(m.group(1)), m.group(2)
        mib = val / 1024 if unit == "KiB" else (val if unit == "MiB" else val * 1024)

        try:
            cpu = float(cpu_str)
        except ValueError:
            cpu = 0.0

        stats[name] = {"ram_mib": mib, "cpu_pct": cpu}  # type: ignore[assignment]
    return stats


def measure(pool_size: int, n_tasks: int, use_grpc: bool = True) -> dict:
    cfg = ShimConfig.from_env()
    cfg.pool_size = pool_size
    cfg.use_grpc = use_grpc

    # --- Prefill ---
    pool = SandboxPool(cfg.sandbox_tag, pool_size)
    t_prefill_start = time.monotonic()
    pool.prefill()
    prefill_ms = (time.monotonic() - t_prefill_start) * 1000

    # Brief settle for docker stats to stabilize
    time.sleep(1.0)
    container_stats = _live_sandbox_stats()
    per_sandbox_ram = [v["ram_mib"] for v in container_stats.values()]  # type: ignore[index]
    per_sandbox_cpu = [v["cpu_pct"] for v in container_stats.values()]  # type: ignore[index]

    # --- Assignment latency ---
    assign_latencies_ms: list[float] = []
    exec_overheads_ms: list[float] = []

    for _ in range(n_tasks):
        # Assignment latency: time to acquire a sandbox from pool
        t0 = time.monotonic()
        with pool.acquire() as sandbox_name:
            assign_ms = (time.monotonic() - t0) * 1000
            assign_latencies_ms.append(assign_ms)

            # Direct subprocess baseline
            t_direct = time.monotonic()
            subprocess.run(_DUMMY_CMD, capture_output=True)
            direct_ms = (time.monotonic() - t_direct) * 1000

            # Sandboxed exec
            if use_grpc:
                from scripts.opensh_shim.dispatcher_grpc import exec_in_sandbox
            else:
                from scripts.opensh_shim.dispatcher_cli import exec_in_sandbox

            t_shim = time.monotonic()
            exec_in_sandbox(sandbox_name, _DUMMY_CMD)
            shim_ms = (time.monotonic() - t_shim) * 1000

            exec_overheads_ms.append(shim_ms - direct_ms)

    pool.teardown()

    # Compute percentiles safely
    def _pct(data: list[float], p: int) -> float:
        if not data:
            return 0.0
        sorted_data = sorted(data)
        idx = max(0, min(int(len(sorted_data) * p / 100), len(sorted_data) - 1))
        return sorted_data[idx]

    report = {
        "pool_size": pool_size,
        "n_tasks": n_tasks,
        "dispatcher": "grpc" if use_grpc else "cli",
        "prefill_ms": round(prefill_ms, 1),
        "containers_observed": len(container_stats),
        "per_sandbox_ram_mib": {
            "mean": round(mean(per_sandbox_ram), 2) if per_sandbox_ram else None,
            "min": round(min(per_sandbox_ram), 2) if per_sandbox_ram else None,
            "max": round(max(per_sandbox_ram), 2) if per_sandbox_ram else None,
        },
        "pool_total_ram_mib": round(sum(per_sandbox_ram), 2),
        "per_sandbox_cpu_pct": {
            "mean": round(mean(per_sandbox_cpu), 3) if per_sandbox_cpu else None,
        },
        "assignment_latency_ms": {
            "p50": round(_pct(assign_latencies_ms, 50), 1),
            "p95": round(_pct(assign_latencies_ms, 95), 1),
            "p99": round(_pct(assign_latencies_ms, 99), 1),
        },
        "exec_overhead_vs_direct_ms": {
            "mean": round(mean(exec_overheads_ms), 1) if exec_overheads_ms else None,
            "median": round(median(exec_overheads_ms), 1) if exec_overheads_ms else None,
            "max": round(max(exec_overheads_ms), 1) if exec_overheads_ms else None,
        },
    }
    return report


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Measure OpenShell sandbox pool")
    parser.add_argument("--pool-size", type=int, default=3)
    parser.add_argument("--tasks", type=int, default=12)
    parser.add_argument("--cli", action="store_true", help="Use CLI dispatcher instead of gRPC")
    args = parser.parse_args()

    report = measure(args.pool_size, args.tasks, use_grpc=not args.cli)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
