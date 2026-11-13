/** Personal inbox routing; company-wide run visibility is unchanged. */
export function isHeartbeatRunVisibleInMine(
  run: { responsibleUserId?: string | null },
  currentUserId: string | null | undefined,
): boolean {
  if (!currentUserId) return false;
  if (run.responsibleUserId) return run.responsibleUserId === currentUserId;
  // Preserve unattributed historical runs for the single-user local board.
  return currentUserId === "local-board";
}

/** The inbox lists failures only when the agent's latest observed run failed. */
export function latestFailedRunsByAgent<T extends { agentId: string; status: string; createdAt: Date | string }>(runs: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const run of [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())) {
    if (!latest.has(run.agentId)) latest.set(run.agentId, run);
  }
  return [...latest.values()].filter((run) => run.status === "failed" || run.status === "timed_out");
}
