"""Read-only campaign readiness. No case selection, database launch or IPC cleanup."""
import argparse
import datetime
import json
import os
import pathlib
import platform
import shutil
import subprocess


def command(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=10)
    return result.returncode, result.stdout


def inspect(root):
    root = pathlib.Path(root).resolve()
    ipc = {"available": False, "semaphore_headroom": None, "shared_memory_headroom": None}
    if platform.system() == "Darwin":
        status, output = command(["ipcs", "-s", "-a"])
        status_m, output_m = command(["ipcs", "-m", "-a"])
        status_limits, output_limits = command(["sysctl", "-n", "kern.sysv.semmns", "kern.sysv.shmmni"])
        if status == status_m == status_limits == 0:
            semaphores = [line.split() for line in output.splitlines() if line.startswith("s ")]
            segments = [line for line in output_m.splitlines() if line.startswith("m ")]
            limits = [int(value) for value in output_limits.split()]
            consumed = sum(int(row[8]) for row in semaphores)
            ipc = {"available": True, "semaphore_sets": len(semaphores), "semaphores_consumed": consumed,
                   "semaphore_limit": limits[0], "semaphore_headroom": limits[0] - consumed,
                   "shared_memory_segments": len(segments), "shared_memory_limit": limits[1],
                   "shared_memory_headroom": limits[1] - len(segments)}
    runner = root / "packages/paperclip-runner/runner/target/debug/paperclip-runnerd"
    tools = {name: bool(shutil.which(name)) for name in ["node", "pnpm", "python3", "codex"]}
    credentials = {name: bool(os.getenv(name)) for name in ["CODEX_AUTH_JSON", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DAYTONA_API_KEY"]}
    status, revision = command(["git", "-C", str(root), "rev-parse", "HEAD"])
    status_dirty, dirty = command(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"])
    # A guard against known exhaustion, not proof that a database will start.
    ipc_guard = ipc["available"] and ipc["semaphore_headroom"] >= 34 and ipc["shared_memory_headroom"] >= 2
    return {"version": 1, "measuredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "scope": "read-only host preflight; no selected-case attempt", "platform": platform.system(),
            "sourceRevision": revision.strip() if status == 0 else None,
            "trackedSourceClean": not dirty.strip() if status_dirty == 0 else None,
            "tools": tools, "runnerExecutable": os.access(runner, os.X_OK),
            "credentialsPresent": credentials,
            "privateCodexAuthFilePresent": (pathlib.Path.home() / ".codex/auth.json").is_file(),
            "localEnvironmentFilePresent": (root / ".env.runner-e2e.local").is_file(),
            "immutableDaytonaImageConfigured": "@sha256:" in os.getenv("PAPERCLIP_E2E_DAYTONA_IMAGE", ""),
            "ipc": ipc, "singleInstanceIpcGuardPassed": ipc_guard,
            "ipcGuardLimits": {"minimumFreeSemaphores": 34, "minimumFreeSharedMemorySlots": 2},
            "limitations": ["Credential existence does not establish account validity.",
                            "IPC headroom does not establish database or browser health.",
                            "No external connected integration is qualified by this inspection."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", default=str(pathlib.Path(__file__).resolve().parents[2]))
    arguments = parser.parse_args()
    print(json.dumps(inspect(arguments.checkout), indent=2))
