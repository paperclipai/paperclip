import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "./index.js";
import { describeLocalInstancePaths, resolvePaperclipInstanceId } from "../config/home.js";

type LockPayload = {
  pid?: number;
  startedAt?: string;
  instanceId?: string;
};

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

export function runtimeLockCheck(instance?: string): CheckResult {
  const instanceId = resolvePaperclipInstanceId(instance);
  const paths = describeLocalInstancePaths(instanceId);
  const lockPath = path.join(paths.instanceRoot, "run.lock.json");

  if (!fs.existsSync(lockPath)) {
    return {
      name: "Runtime lock",
      status: "pass",
      message: "No active run lock detected",
      canRepair: false,
    };
  }

  let payload: LockPayload = {};
  try {
    payload = JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockPayload;
  } catch {
    return {
      name: "Runtime lock",
      status: "warn",
      message: `Lock file exists but is unreadable: ${lockPath}`,
      canRepair: true,
      repairHint: "Remove stale/corrupt lock file and retry",
      repair: () => {
        fs.rmSync(lockPath, { force: true });
      },
    };
  }

  const pid = typeof payload.pid === "number" ? payload.pid : -1;
  if (isPidAlive(pid)) {
    return {
      name: "Runtime lock",
      status: "warn",
      message: `Another paperclipai run appears active (pid=${pid}, lock=${lockPath})`,
      canRepair: false,
      repairHint: "Stop active run before starting another instance",
    };
  }

  return {
    name: "Runtime lock",
    status: "warn",
    message: `Stale run lock detected (pid=${pid}, lock=${lockPath})`,
    canRepair: true,
    repairHint: "Remove stale lock and retry",
    repair: () => {
      fs.rmSync(lockPath, { force: true });
    },
  };
}
