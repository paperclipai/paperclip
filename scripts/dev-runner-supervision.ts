import path from "node:path";

export interface DevSupervisorRecordSummary {
  serviceKey: string;
  serviceName: string;
  pid: number;
  repoRoot: string | null;
  port: number | null;
  startedAt: string | null;
}

/**
 * Find a live dev supervisor that already owns this repository checkout.
 *
 * The registry's own adoption check keys on the *believed* port, so two
 * supervisors that disagree with the server about the port still produce the
 * same service key and the second one simply overwrites the first one's
 * record. Worse, the dev-server status and restart-request files are keyed on
 * the repo root alone, so a second supervisor shares one status file with the
 * first and the `/api/health` `devServer` block starts describing whichever
 * process wrote last. One supervisor per checkout is the invariant those files
 * were designed around; enforce it here rather than letting the second process
 * silently take the next free port (TES-2189).
 */
export function findConflictingDevSupervisor(input: {
  records: DevSupervisorRecordSummary[];
  repoRoot: string;
  currentPid: number;
  isPidAlive: (pid: number) => boolean;
}): DevSupervisorRecordSummary | null {
  const repoRoot = path.resolve(input.repoRoot);

  for (const record of input.records) {
    if (!record.repoRoot) continue;
    if (path.resolve(record.repoRoot) !== repoRoot) continue;
    if (record.pid === input.currentPid) continue;
    if (!input.isPidAlive(record.pid)) continue;
    return record;
  }

  return null;
}

export function formatConflictingDevSupervisorMessage(input: {
  conflict: DevSupervisorRecordSummary;
  repoRoot: string;
}): string {
  const { conflict } = input;
  const where = conflict.port ? ` on port ${conflict.port}` : "";
  const since = conflict.startedAt ? ` since ${conflict.startedAt}` : "";
  return [
    `[paperclip] refusing to start: ${conflict.serviceName} (pid ${conflict.pid}) already supervises this checkout${where}${since}.`,
    `[paperclip] repo root: ${input.repoRoot}`,
    "[paperclip] Two supervisors on one checkout share .paperclip/dev-server-status.json and",
    "[paperclip] .paperclip/dev-server-restart-request.json, which makes /api/health report the",
    "[paperclip] other process and leaves restart requests unowned. Stop the running supervisor",
    `[paperclip] (kill ${conflict.pid}) before starting another one.`,
  ].join("\n");
}

// ~10s of failed probes before the first warning, then roughly every 5 minutes.
const FIRST_HEALTH_PROBE_FAILURE_REPORT = 4;
const REPEAT_HEALTH_PROBE_FAILURE_REPORT_INTERVAL = 120;

/**
 * Decide whether a run of failed health probes is worth a log line.
 *
 * A supervisor that cannot reach its own child is completely inert: it can
 * neither auto-restart on backend changes nor service a manual restart
 * request. That state used to be silent because the probe failure was caught
 * and discarded on every poll, so a supervisor pointed at the wrong port
 * looked healthy for days (TES-2189).
 */
export function shouldReportHealthProbeFailure(consecutiveFailures: number): boolean {
  if (consecutiveFailures < FIRST_HEALTH_PROBE_FAILURE_REPORT) return false;
  if (consecutiveFailures === FIRST_HEALTH_PROBE_FAILURE_REPORT) return true;
  return (
    (consecutiveFailures - FIRST_HEALTH_PROBE_FAILURE_REPORT)
      % REPEAT_HEALTH_PROBE_FAILURE_REPORT_INTERVAL
    === 0
  );
}
