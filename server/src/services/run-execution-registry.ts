// Shared, module-level registry of runs this server process is executing.
//
// Two independent things make a heartbeat run live inside this process, and
// until now only one of them was visible outside heartbeat.ts:
//
// - `runningProcesses` (adapters/utils.js): the run is carried by a local child
//   process that the server spawned and still holds a handle to.
// - `activeRunExecutions` (below): the run is executing in-process, inside an
//   `adapter.execute()` call. Adapters that drive a local HTTP server or an SDK
//   — including every plugin adapter — are live this way and never appear in
//   `runningProcesses`.
//
// The recovery backstop consulted only the first, so an in-process execution
// looked exactly like a crashed one and got terminalized mid-run. Both live
// here so heartbeat.ts and recovery/service.ts share one answer instead of each
// keeping a partial view.
import { findServerAdapter, runningProcesses } from "../adapters/index.js";

// Routes and the scheduler construct separate heartbeatService instances, but
// they must agree on in-process adapter executions when reaping stale runs.
export const activeRunExecutions = new Set<string>();

/**
 * True when this server process is still executing the run, either as a local
 * child process or as an in-process `adapter.execute()` call. A false answer is
 * not by itself proof the run is dead: the server may have restarted since the
 * run started, which is exactly the case the process-death authority exists to
 * catch.
 */
export function isRunExecutingInProcess(runId: string): boolean {
  return runningProcesses.has(runId) || activeRunExecutions.has(runId);
}

// Adapters that predate the `tracksLocalChildProcess` capability flag. Each one
// runs its agent as a single long-lived local child process, so a dead recorded
// pid means a dead run. Kept only as the fallback for adapters that declare
// nothing; new adapters should declare the capability instead of being added
// here.
const LEGACY_LOCAL_CHILD_PROCESS_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

/**
 * True when `heartbeat_runs.process_pid` / `process_group_id` describe the
 * process that carries the run, so their death is evidence the run died.
 *
 * Plugin adapters resolve to false unless they opt in, because `onSpawn` is
 * free to report short-lived children — an adapter that shells out per tool
 * call reports one child per `run_command`, and each of those pids dies within
 * seconds while the run keeps working.
 */
export function adapterTracksLocalChildProcess(adapterType: string): boolean {
  const adapter = findServerAdapter(adapterType);
  if (adapter && typeof adapter.tracksLocalChildProcess === "boolean") {
    return adapter.tracksLocalChildProcess;
  }
  return LEGACY_LOCAL_CHILD_PROCESS_ADAPTERS.has(adapterType);
}
