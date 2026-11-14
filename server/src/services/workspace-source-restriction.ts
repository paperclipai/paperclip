// Dependency-free so run-failure reporting can classify this outcome without
// loading the checkout and credential graph behind isolated source handling.
export const RESTRICTED_WORKSPACE_SOURCE_REASON = "workspace_source_restricted";

/** The shared checkout holds a task workspace that the run's actor cannot read. */
export function isRestrictedWorkspaceSourceDenial(error: unknown): boolean {
  const denial = error as { status?: unknown; message?: unknown } | null;
  return denial?.status === 403 && denial.message === "Task workspace access is no longer available";
}
