import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readProcessStartedAt } from "./hot-restart.js";

/**
 * Identity of the server process that started a provider side effect, saved
 * with its durable record. After a restart, recovery uses it to prove that the
 * starter has exited, so the side effect cannot still be in flight there.
 */
export type ControllerProcess = { bootId: string; pid: number; hostHash: string; processStartedAt: string | null };

const bootId = randomUUID();
const hostHash = createHash("sha256").update(hostname()).digest("hex").slice(0, 32);
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

/** True only with same-host proof that the recorded server process has exited.
 * Another host, this process, or an ambiguous live PID returns false. */
export async function controllerProcessExited(controller: ControllerProcess): Promise<boolean> {
  if (controller.bootId === bootId || controller.hostHash !== hostHash) return false;
  if (!processExists(controller.pid)) return true;
  // The PID now belongs to a live process, possibly this restarted server.
  // Only a definitely different start time proves the recorded process is gone.
  const recorded = Date.parse(controller.processStartedAt ?? "");
  const observed = await observedProcessStartedAt(controller.pid);
  return Number.isFinite(recorded) && observed !== null && Math.abs(observed - recorded) >= 1_000;
}
