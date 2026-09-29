/** A queued parent wake can be suppressed while its child still runs. This is
 * not a provider failure: admission never started. Keep it in the evidence. */
export function isBlockedUnstartedWake(run: Record<string, unknown>) {
  return run.status === "cancelled" && run.errorCode === "issue_dependencies_blocked" && run.startedAt === null;
}
