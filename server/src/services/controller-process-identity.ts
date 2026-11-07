import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { readProcessStartedAt } from "./hot-restart.js";

/**
 * Identity of the server process that started a provider side effect, saved
 * with its durable record. After a restart, recovery uses it to prove that the
 * starter has exited, so the side effect cannot still be in flight there.
 */
export type ControllerProcess = { bootId: string; pid: number; hostHash: string; processStartedAt: string | null };

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
    } else {
      // No PID namespaces here. The boot time keeps a rebooted host distinct;
      // rounding can only make a record unmatched, which fails closed.
      parts.push(String(Math.round((Date.now() - uptime() * 1000) / 600_000)));
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

/** OS-observed start time of this server process (epoch ms), read at most once
 * successfully per process. Null when the OS cannot report it. */
export function currentProcessStartedAtMs(): Promise<number | null> {
  if (!ownStartedAt) {
    const read = observedProcessStartedAt(process.pid);
    ownStartedAt = read;
    void read.then(value => {
      if (value === null && ownStartedAt === read) ownStartedAt = undefined;
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

/** Hash of this process's PID space (host, kernel boot and PID namespace), or
 * "unknown" when it cannot be read. The owner prover stamps and compares it. */
export function currentProcessSpaceHash(): string {
  return hostHash;
}

export async function currentControllerProcess(): Promise<ControllerProcess> {
  const startedAt = await currentProcessStartedAtMs();
  return { bootId, pid: process.pid, hostHash,
    processStartedAt: startedAt === null ? null : new Date(startedAt).toISOString() };
}

export function readControllerProcess(value: unknown): ControllerProcess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.bootId !== "string" || typeof record.hostHash !== "string" ||
      typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  return { bootId: record.bootId, pid: record.pid, hostHash: record.hostHash,
    processStartedAt: typeof record.processStartedAt === "string" ? record.processStartedAt : null };
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
  // The PID now belongs to a live process, possibly this restarted server.
  // Only a definitely different start time proves the recorded process is gone.
  const observed = await observedProcessStartedAt(controller.pid);
  return observed !== null && processStartsDefinitelyDiffer(controller.processStartedAt, new Date(observed));
}
