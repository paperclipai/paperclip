import { execFile } from "node:child_process";

/** Report printed by `paperclip-runnerd reap-lineage`. */
export const RUNNER_LINEAGE_REAP_SCHEMA = "paperclip.runner.process-lineage-reap.v1";

export interface RunnerLineageReapReport {
  schema: typeof RUNNER_LINEAGE_REAP_SCHEMA;
  verified: boolean;
  reason: string | null;
  journals: number;
  signalled: number;
  remaining: number[];
}

/**
 * Stops and proves gone every provider and tool process that a local runnerd
 * journalled, after that runnerd has exited.
 *
 * runnerd is the only owner of its provider's process tree. When runnerd is
 * killed (for example mid-tool), the provider and its tools are re-parented
 * and can no longer be found from the controller's process records. Durable
 * runnerd journals each lineage (PID, group and session with their start
 * times) under `<state-dir>/process-lineage/`; the same runnerd executable
 * reads that journal, signals only processes whose identity still matches,
 * and reports whether none remain.
 *
 * Returns the report, or `null` when no report could be read (for example a
 * runnerd built before the journal existed). Any result other than
 * `verified: true` keeps the caller's fail-closed handling.
 */
export async function reapExitedRunnerLineage(input: {
  runnerBinaryPath: string;
  stateDirectory: string;
  runnerPid: number;
  timeoutMs: number;
}): Promise<RunnerLineageReapReport | null> {
  if (!Number.isSafeInteger(input.runnerPid) || input.runnerPid <= 1) return null;
  // Reaping is bounded by the controller's close deadline. runnerd's own
  // deadline is set below it so a report always arrives before the kill.
  const timeoutMs = Math.max(1_000, Math.floor(input.timeoutMs));
  const deadlineMs = Math.max(500, timeoutMs - 500);
  const graceMs = Math.min(1_000, Math.floor(deadlineMs / 2));
  const stdout = await new Promise<string | null>((resolveOutput) => {
    execFile(
      input.runnerBinaryPath,
      [
        "reap-lineage",
        "--state-dir", input.stateDirectory,
        "--runner-pid", String(input.runnerPid),
        "--grace-ms", String(graceMs),
        "--deadline-ms", String(deadlineMs),
      ],
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? "" } },
      // A refusal exits non-zero but still prints its report.
      (_error, output) => resolveOutput(typeof output === "string" ? output : null),
    );
  });
  return parseRunnerLineageReapReport(stdout);
}

export function parseRunnerLineageReapReport(stdout: string | null): RunnerLineageReapReport | null {
  const line = stdout?.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.schema !== RUNNER_LINEAGE_REAP_SCHEMA || typeof value.verified !== "boolean"
      || !Number.isSafeInteger(value.journals) || !Number.isSafeInteger(value.signalled)
      || !Array.isArray(value.remaining) || !value.remaining.every(pid => Number.isSafeInteger(pid))
      || (value.reason !== null && typeof value.reason !== "string")) return null;
    // A verified report never names a remaining process.
    if (value.verified && (value.remaining.length > 0 || value.reason !== null)) return null;
    return value as unknown as RunnerLineageReapReport;
  } catch {
    return null;
  }
}
