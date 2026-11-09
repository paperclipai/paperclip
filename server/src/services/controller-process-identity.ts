import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { readProcessStartedAt } from "./hot-restart.js";
import { currentWorkspaceWorker, type WorkspaceWorker } from "./native-runtime/native-workspace-platform-proof.js";

/**
 * Identity of the server process that started a provider side effect, saved
 * with its durable record. After a restart, recovery uses it to prove that the
 * starter has exited, so the side effect cannot still be in flight there.
 */
export type ControllerDeployment = { worker: WorkspaceWorker; exclusiveVolume: boolean; volumeId: string | null };
export type ControllerProcess = {
  bootId: string; pid: number; hostHash: string; processStartedAt: string | null; deployment?: ControllerDeployment;
};

export function currentControllerDeployment(env: NodeJS.ProcessEnv = process.env): ControllerDeployment | null {
  const worker = currentWorkspaceWorker(env);
  if (!worker) return null;
  const volumeId = env.RAILWAY_VOLUME_ID?.trim() || null;
  return { worker, exclusiveVolume: Boolean(volumeId && env.RAILWAY_VOLUME_MOUNT_PATH?.trim()), volumeId };
}

function deploymentField(): { deployment?: ControllerDeployment } {
  const deployment = currentControllerDeployment();
  return deployment ? { deployment } : {};
}

function readDeployment(value: unknown): ControllerDeployment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const worker = record.worker as Record<string, unknown> | null | undefined;
  if (!worker || typeof worker !== "object" || worker.provider !== "railway") return null;
  const ids = [worker.projectId, worker.environmentId, worker.serviceId, worker.deploymentId];
  if (ids.some(id => typeof id !== "string" || id.length === 0)) return null;
  return { worker: { provider: "railway", projectId: ids[0] as string, environmentId: ids[1] as string,
    serviceId: ids[2] as string, deploymentId: ids[3] as string },
  exclusiveVolume: record.exclusiveVolume === true,
  volumeId: typeof record.volumeId === "string" ? record.volumeId : null };
}

/**
 * The one boot id of this server process. Native coordinator claims
 * (`native_run_finalizations.controller_boot_id`), legacy controller leases
 * (`heartbeat_runs.controller_boot_id`), sandbox creation intents and teardown
 * claims all stamp this value, so "owned by this process" means the same thing
 * in every table. Records written by an older release carry that release's
 * random per-module ids; those never equal this value, exactly as a record
 * from any earlier boot never did.
 */
const bootId = randomUUID();
export const UNKNOWN_PROCESS_SPACE = "unknown";

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

/** OS-observed start time of any PID (epoch ms), or null when it cannot be read. */
export async function observedProcessStartedAt(pid: number): Promise<number | null> {
  try {
    const startedAt = Date.parse(await readProcessStartedAt(pid) ?? "");
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

// This process's own start time never changes, so it is read from the OS once.
// On macOS the read runs `ps -o lstart`; uncached, it ran on every native
// claim, preparation check and lease renewal. A failed read is not cached, so
// a transient failure is retried by the next caller.
let ownStartedAt: Promise<number | null> | undefined;
/** The start time from the last resolved read, for `currentControllerProcessStamp`. */
let resolvedProcessStartedAt: string | null = null;

/** OS-observed start time of this server process (epoch ms), read at most once
 * successfully per process. Null when the OS cannot report it. */
export function currentProcessStartedAtMs(): Promise<number | null> {
  if (!ownStartedAt) {
    const read = observedProcessStartedAt(process.pid);
    ownStartedAt = read;
    void read.then(value => {
      if (value === null && ownStartedAt === read) ownStartedAt = undefined;
      // Any resolved read also feeds the no-I/O stamp.
      if (value !== null) resolvedProcessStartedAt = new Date(value).toISOString();
    });
  }
  return ownStartedAt;
}

/** Test seam: forget the cached start time so a test can stub the OS read. */
export function resetCurrentProcessStartedAtForTests(): void {
  ownStartedAt = undefined;
}

export function currentControllerBootId(): string {
  return bootId;
}

const stampListeners = new Set<() => void>();
/** Called (synchronously, without I/O) whenever this process stamps ownership of a record. */
export function onControllerStamp(listener: () => void): () => void {
  stampListeners.add(listener);
  return () => { stampListeners.delete(listener); };
}
function notifyStamp() {
  for (const listener of stampListeners) {
    try { listener(); } catch { /* a listener never blocks a stamp */ }
  }
}

export async function currentControllerProcess(): Promise<ControllerProcess> {
  const startedAt = await currentProcessStartedAtMs();
  const iso = startedAt === null ? null : new Date(startedAt).toISOString();
  resolvedProcessStartedAt = iso;
  notifyStamp();
  return { bootId, pid: process.pid, hostHash, processStartedAt: iso, ...deploymentField() };
}

/**
 * This process's identity without any I/O, for stamps written on the turn
 * path. The start time is present only once an earlier call resolved it. A
 * stamp without one still proves exit when its PID is gone in this PID space;
 * a live PID then stays ambiguous, which fails closed.
 */
export function currentControllerProcessStamp(): ControllerProcess {
  notifyStamp();
  return { bootId, pid: process.pid, hostHash, processStartedAt: resolvedProcessStartedAt, ...deploymentField() };
}

export function readControllerProcess(value: unknown): ControllerProcess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.bootId !== "string" || typeof record.hostHash !== "string" ||
      typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  const deployment = readDeployment(record.deployment);
  return { bootId: record.bootId, pid: record.pid, hostHash: record.hostHash,
    processStartedAt: typeof record.processStartedAt === "string" ? record.processStartedAt : null,
    ...(deployment ? { deployment } : {}) };
}

/**
 * True when some process owns the PID in this PID space. EPERM means the
 * process exists but belongs to another user, so it counts as alive.
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** Process start times closer than this may be the same process. */
export const PROCESS_START_PRECISION_MS = 1_000;

/**
 * True only when two start times for one PID prove different processes.
 * `ps -o lstart` on macOS and BSD has whole-second precision, while a recorded
 * start can come from a millisecond clock, so a sub-second gap is ambiguous
 * and fails closed (same process). A missing or unparsable time proves nothing.
 */
export function processStartsDefinitelyDiffer(
  recorded: Date | string | null | undefined,
  observed: Date | string | null | undefined,
): boolean {
  const left = recorded instanceof Date ? recorded.getTime() : Date.parse(recorded ?? "");
  const right = observed instanceof Date ? observed.getTime() : Date.parse(observed ?? "");
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) >= PROCESS_START_PRECISION_MS;
}

/** True only with proof, in this process's own PID space, that the recorded
 * server process has exited. Another space, an unreadable space, this server,
 * or an ambiguous live PID returns false. */
export async function controllerProcessExited(controller: ControllerProcess): Promise<boolean> {
  if (controller.bootId === bootId || hostHash === UNKNOWN_PROCESS_SPACE || controller.hostHash !== hostHash) return false;
  if (!processExists(controller.pid)) return true;
  // Without a recorded start time a live PID can never prove exit; skip the probe.
  if (!Number.isFinite(Date.parse(controller.processStartedAt ?? ""))) return false;
  // The PID now belongs to a live process, possibly this restarted server.
  // Only a definitely different start time proves the recorded process is gone.
  const observed = await observedProcessStartedAt(controller.pid);
  return observed !== null && processStartsDefinitelyDiffer(controller.processStartedAt, new Date(observed));
}

/** This process's PID-space hash. An unreadable space is stored as
 * "unknown", which `sameProcessSpace` never accepts. */
export function currentProcessSpaceHash(): string {
  return hostHash;
}

/**
 * Whether a PID recorded under `recorded` can be judged in this process.
 * True only for the same readable PID space. A different or unreadable space
 * is never proof: a dead PID here says nothing about a process elsewhere.
 */
export function sameProcessSpace(recorded: string | null | undefined): boolean {
  return typeof recorded === "string" && hostHash !== UNKNOWN_PROCESS_SPACE && recorded === hostHash;
}
