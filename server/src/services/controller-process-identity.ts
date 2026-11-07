import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { readProcessStartedAt } from "./hot-restart.js";

/**
 * Identity of the server process that started a provider side effect, saved
 * with its durable record. After a restart, recovery uses it to prove that the
 * starter has exited, so the side effect cannot still be in flight there.
 */
export type ControllerProcess = { bootId: string; pid: number; hostHash: string; processStartedAt: string | null };

const bootId = randomUUID();
const UNKNOWN_PROCESS_SPACE = "unknown";

/**
 * Names the space in which PIDs are comparable: one kernel boot and, on Linux,
 * one PID namespace. Containers that share a hostname but not a PID namespace
 * get different values. When the space cannot be read, no record is judged.
 * A redeploy onto another host or namespace also never matches; such records
 * keep their original deadlines.
 */
function processSpaceHash(): string {
  try {
    const parts = [hostname()];
    if (process.platform === "linux") {
      parts.push(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), readlinkSync("/proc/self/ns/pid"));
    } else if (process.platform === "darwin") {
      // One bounded, read-only kernel identity observation per module. Rounded
      // boot-time estimates can collide across hosts and cannot authorize PID
      // comparisons. Old weak hashes simply stop matching this stronger proof.
      const bootSession = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8", timeout: 1_500, maxBuffer: 4_096, windowsHide: true,
      }).trim().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootSession)) return UNKNOWN_PROCESS_SPACE;
      parts.push(bootSession);
    } else {
      return UNKNOWN_PROCESS_SPACE;
    }
    if (parts.some(part => !part)) return UNKNOWN_PROCESS_SPACE;
    return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  } catch {
    return UNKNOWN_PROCESS_SPACE;
  }
}

const hostHash = processSpaceHash();
let processStartedAt: Promise<string | null> | undefined;

async function observedProcessStartedAt(pid: number): Promise<number | null> {
  try {
    const startedAt = Date.parse(await readProcessStartedAt(pid) ?? "");
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

export function currentControllerBootId(): string {
  return bootId;
}

export async function currentControllerProcess(): Promise<ControllerProcess> {
  processStartedAt ??= observedProcessStartedAt(process.pid)
    .then(value => value === null ? null : new Date(value).toISOString());
  return { bootId, pid: process.pid, hostHash, processStartedAt: await processStartedAt };
}

export function readControllerProcess(value: unknown): ControllerProcess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.bootId !== "string" || typeof record.hostHash !== "string" ||
      typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  return { bootId: record.bootId, pid: record.pid, hostHash: record.hostHash,
    processStartedAt: typeof record.processStartedAt === "string" ? record.processStartedAt : null };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** True only with proof, in this process's own PID space, that the recorded
 * server process has exited. Another space, an unreadable space, this server,
 * or an ambiguous live PID returns false. */
export async function controllerProcessExited(controller: ControllerProcess): Promise<boolean> {
  if (controller.bootId === bootId || hostHash === UNKNOWN_PROCESS_SPACE || controller.hostHash !== hostHash) return false;
  if (!processExists(controller.pid)) return true;
  // The PID now belongs to a live process, possibly this restarted server.
  // Only a definitely different start time proves the recorded process is gone.
  const recorded = Date.parse(controller.processStartedAt ?? "");
  const observed = await observedProcessStartedAt(controller.pid);
  return Number.isFinite(recorded) && observed !== null && Math.abs(observed - recorded) >= 1_000;
}
