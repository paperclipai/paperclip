/**
 * In-memory registry of heartbeat run "handles" — the live adapters/processes
 * the control plane currently supervises. Shared across `heartbeatService`
 * instances (routes + scheduler construct independent service objects but must
 * agree on which runs are genuinely in flight) and consulted by the issue
 * ownership path (`services/issues.ts`) to recover from the "zombie
 * executionRunId" window documented in ADR-0001 (VIR-295 / VIR-296).
 *
 * The registry is intentionally a tiny module-scoped singleton rather than a
 * service object because it must be importable by both `heartbeat.ts` (which
 * owns the producer side) and `issues.ts` (the consumer side) without
 * introducing a circular service dependency. Only opaque run ids and a boolean
 * "is this adapter type tracked as a local child process?" check leave the
 * module — never secrets, PII, or run payloads.
 */

import { runningProcesses } from "../adapters/index.js";
import { isProcessGroupAlive } from "./local-service-supervisor.js";

/**
 * Adapters whose child process lifecycle is tracked in-process via
 * `runningProcesses` / `PID + processGroupId`. For these adapters a missing
 * in-memory handle plus a dead PID is strong evidence the run is gone even if
 * the database row still says `running`. This set mirrors the one in
 * `heartbeat.ts`; keep them in sync when adding adapter types.
 */
const SESSIONED_LOCAL_ADAPTERS = new Set<string>([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

/**
 * Runs whose background heartbeat execution is in flight inside this control
 * plane process. Producer side lives in `heartbeat.ts`; consumer side (the
 * ownership recovery path) reads it here. A single module instance backs every
 * `heartbeatService`, so all callers observe the same set.
 */
const activeRunExecutions = new Set<string>();

/** Background heartbeat execution promises (for graceful shutdown / test_drain). */
const activeRunExecutionPromises = new Set<Promise<void>>();

export function markActiveRunExecution(runId: string): void {
  activeRunExecutions.add(runId);
}

export function unmarkActiveRunExecution(runId: string): void {
  activeRunExecutions.delete(runId);
}

export function isActiveRunExecution(runId: string): boolean {
  return activeRunExecutions.has(runId);
}

export function registerActiveRunExecutionPromise(promise: Promise<void>): void {
  activeRunExecutionPromises.add(promise);
  void promise.finally(() => activeRunExecutionPromises.delete(promise));
}

export async function drainActiveRunExecutionPromises(): Promise<void> {
  while (activeRunExecutionPromises.size > 0) {
    const snapshot = Array.from(activeRunExecutionPromises);
    await Promise.allSettled(snapshot);
  }
}

/** Whether the run id has any in-memory handle the control plane is aware of. */
export function isRunHandleLive(runId: string): boolean {
  return runningProcesses.has(runId) || activeRunExecutions.has(runId);
}

export function isTrackedLocalChildProcessAdapter(adapterType: string | null | undefined): boolean {
  return !!adapterType && SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

/**
 * Best-effort `process.kill(pid, 0)`. A positive result means some process owns
 * the PID right now (or `EPERM`, which still means there is a process we cannot
 * signal — treat as alive). `ESRCH`/missing PID means the process is gone.
 * Mirrors `isProcessAlive` in `heartbeat.ts`.
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Decide whether a run whose database row still claims `running` is actually
 * unreachable, so the issue ownership path can relax its guard (ADR-0001 Fix A).
 *
 * A run is considered "handle-lost" only when BOTH of these hold, to avoid
 * false positives:
 *  - the control plane has no in-memory handle for it
 *    (`runningProcesses`/`activeRunExecutions`); AND
 *  - either the adapter is not tracked as a local child process (we cannot
 *    reach a PID to check), or it is tracked AND neither its `processPid` nor
 *    its `processGroupId` is alive.
 *
 * For adapters we DO track, requiring the loss of BOTH the in-memory handle
 * and a live PID matches the predicate `reapOrphanedRuns` uses to mark a run
 * `failed/process_lost`, so the ownership recovery never races ahead of the
 * reaper into territory the reaper itself would still clear.
 */
export type RunHandleLostInput = {
  runId: string;
  adapterType: string | null | undefined;
  processPid: number | null | undefined;
  processGroupId: number | null | undefined;
};

export function isRunHandleLost(input: RunHandleLostInput): boolean {
  if (isRunHandleLive(input.runId)) return false;
  if (!isTrackedLocalChildProcessAdapter(input.adapterType)) {
    // Untracked adapter: we have no PID to corroborate, so we only treat the
    // run as lost if there is truly no in-memory handle. `isRunHandleLive`
    // above already returned false to get here; trust that signal.
    return true;
  }
  const pidAlive = isProcessAlive(input.processPid);
  const groupAlive = isProcessGroupAlive(input.processGroupId);
  return !pidAlive && !groupAlive;
}
