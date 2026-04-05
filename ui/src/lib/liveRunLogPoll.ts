/** Heartbeat run statuses after which log polling is unnecessary. */
export function isTerminalRunStatus(status: string): boolean {
  return status === "failed" || status === "timed_out" || status === "cancelled" || status === "succeeded";
}

export function filterRunsForLogPolling<T extends { status: string }>(runs: T[]): T[] {
  return runs.filter((run) => !isTerminalRunStatus(run.status));
}
