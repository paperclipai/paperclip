const UNASSIGNABLE_AGENT_STATUSES = new Set([
  "error",
  "paused",
  "terminated",
  "pending_approval",
]);

export function isAgentAssignableStatus(status: string | null | undefined) {
  return !UNASSIGNABLE_AGENT_STATUSES.has(status ?? "");
}
