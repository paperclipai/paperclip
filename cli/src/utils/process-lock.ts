import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProcessLock {
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we lack permission to signal it → still alive
    // ESRCH = no such process → not alive
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPidFile(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(lockPath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, String(process.pid), "utf8");
}

function tryAcquire(lockPath: string, processLabel: string): void {
  const existingPid = readPidFile(lockPath);
  if (existingPid !== null) {
    if (isProcessAlive(existingPid) && existingPid !== process.pid) {
      throw new Error(
        `Another ${processLabel} process (PID ${existingPid}) is already running for this instance.\n` +
          `Lock file: ${lockPath}\n` +
          `Stop the existing process first, or remove the lock file if it is stale.`,
      );
    }
    // Stale lock from a dead process — clean it up
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore if already gone
    }
  }
  writePidFile(lockPath);
}

function attachExitCleanup(lockPath: string): ProcessLock {
  function cleanup() {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }

  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  const onSigterm = () => {
    cleanup();
    process.exit(143);
  };

  process.on("exit", cleanup);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    release() {
      cleanup();
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
  };
}

/** Acquires an exclusive PID-file lock for `paperclipai run`. Throws if already held by a live process. */
export function acquireRunLock(instanceRoot: string): ProcessLock {
  const lockPath = path.join(instanceRoot, "run.lock");
  tryAcquire(lockPath, "paperclipai run");
  return attachExitCleanup(lockPath);
}

/** Acquires an exclusive PID-file lock for `paperclipai doctor --repair`. Throws if already held by a live process. */
export function acquireRepairLock(instanceRoot: string): ProcessLock {
  const lockPath = path.join(instanceRoot, "repair.lock");
  tryAcquire(lockPath, "paperclipai doctor --repair");
  return attachExitCleanup(lockPath);
}

/**
 * Returns the PID held in the run lock if a live process owns it, or null.
 * Treats the current process's own PID as "not a conflict".
 */
export function checkRunLock(instanceRoot: string): number | null {
  const lockPath = path.join(instanceRoot, "run.lock");
  const pid = readPidFile(lockPath);
  if (pid !== null && pid !== process.pid && isProcessAlive(pid)) return pid;
  return null;
}

/**
 * Returns true if `paperclip.service` is active via systemd.
 * Returns false when systemctl is unavailable or the service is not active.
 */
export function isSystemdServiceActive(serviceName: string): boolean {
  try {
    execFileSync("systemctl", ["is-active", "--quiet", serviceName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies a file to `<filePath>.bak.<timestamp>` before it is overwritten by a repair.
 * Returns the backup path on success, or null if the file does not exist or backup fails.
 */
export function backupFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const backupPath = `${filePath}.bak.${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
