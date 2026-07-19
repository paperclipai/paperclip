import { isProcessGroupAlive } from "./local-service-supervisor.js";

/**
 * Adapters whose heartbeat runs execute as tracked local child processes. For
 * these, the recorded OS pid / process-group id are authoritative liveness
 * signals: if neither is alive, the run's process is gone regardless of what the
 * `status` column still says.
 *
 * Kept in sync with `SESSIONED_LOCAL_ADAPTERS` in heartbeat.ts and
 * recovery/service.ts — those construct their own copies for the periodic
 * reaper; this leaf module exists so ownership/checkout code can make the same
 * judgement without importing the heartbeat service (which would create an
 * import cycle).
 */
export const LOCAL_CHILD_PROCESS_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

function hasHotRestartAdoption(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson || typeof resultJson !== "object") return false;
  const hotRestart = (resultJson as Record<string, unknown>).hotRestart;
  if (!hotRestart || typeof hotRestart !== "object") return false;
  const adopted = (hotRestart as Record<string, unknown>).adopted;
  const adoptedAt = (hotRestart as Record<string, unknown>).adoptedAt;
  return adopted === true && typeof adoptedAt === "string";
}

export type LocalChildRunLivenessInput = {
  status: string | null | undefined;
  adapterType: string | null | undefined;
  processPid: number | null | undefined;
  processGroupId: number | null | undefined;
  resultJson?: Record<string, unknown> | null;
};

/**
 * Returns true when a run that is still marked `running` in the DB has actually
 * lost its process, and therefore holds no real claim on any checkout/execution
 * lock. Mirrors the authoritative gate in heartbeat.ts `reapOrphanedRuns`:
 *
 *  - only local-child-process adapters can be judged this way (they have a pid),
 *  - a run adopted across a hot restart is never treated as dead,
 *  - if either the pid or the process group is still alive, the run is alive,
 *  - the run must have had a pid or process group recorded — with neither, we
 *    cannot conclude the process is gone and fall back to status-based checks.
 *
 * This lets a fresh wake run of the same assignee reclaim a checkout whose
 * owning run's process died, without waiting up to ~5 minutes for the periodic
 * reaper to transition that run to a terminal status (NEO-574).
 */
export function localChildRunProcessIsDead(run: LocalChildRunLivenessInput): boolean {
  if (run.status !== "running") return false;
  if (!run.adapterType || !LOCAL_CHILD_PROCESS_ADAPTERS.has(run.adapterType)) return false;
  if (hasHotRestartAdoption(run.resultJson)) return false;
  const hasProcessHandle = run.processPid != null || run.processGroupId != null;
  if (!hasProcessHandle) return false;
  const pidAlive = run.processPid != null && isProcessAlive(run.processPid);
  const groupAlive = run.processGroupId != null && isProcessGroupAlive(run.processGroupId);
  return !pidAlive && !groupAlive;
}
