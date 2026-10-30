/** A queued parent wake can be suppressed while its child still runs. This is
 * not a provider failure: admission never started. Keep it in the evidence. */
export function isBlockedUnstartedWake(run: Record<string, unknown>) {
  return run.status === "cancelled" && run.errorCode === "issue_dependencies_blocked" && run.startedAt === null;
}

/** A terminal issue may make a queued wake obsolete before provider admission. */
export function isTerminalUnstartedWake(
  run: Record<string, unknown>,
  tasks: Array<{ id: string; status?: unknown }>,
) {
  const context = run.contextSnapshot;
  const issueId = context && typeof context === "object" && "issueId" in context ? context.issueId : undefined;
  return run.status === "cancelled" && run.errorCode === "issue_terminal_status" &&
    run.startedAt === null && tasks.some(task =>
      task.id === issueId && ["done", "cancelled"].includes(String(task.status)),
    );
}
