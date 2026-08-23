/**
 * Write-time shape check for the `issues:cross-write` grant (FAI-10132).
 *
 * The evaluator already refuses a scope it cannot constrain on
 * (`scopeAllows(..., { requireRecognizedConstraint: true })`). This is the
 * other half: an admin who saves `{"note":"scoped for the sweep"}` believes
 * they granted something narrow, and without this check the grant is stored,
 * shown in the UI as a scoped grant, and confers nothing — or, before
 * `requireRecognizedConstraint`, conferred everything. Rejecting the shape at
 * save time is what makes the two stories match (FAI-10134 blocking finding 3).
 */

export const CROSS_ISSUE_WRITE_PERMISSION_KEY = "issues:cross-write";

/**
 * Scope keys `scopeAllows` actually narrows on. Kept in sync by the
 * `recognized cross-write scope keys` test in `authorization-service.test.ts`.
 */
export const CROSS_ISSUE_WRITE_SCOPE_KEYS = [
  "projectId",
  "projectIds",
  "agentId",
  "agentIds",
  "assigneeAgentId",
  "assigneeAgentIds",
  "targetAgentId",
  "targetAgentIds",
  "managerAgentId",
  "managerAgentIds",
  "managedSubtreeAgentId",
  "managedSubtreeAgentIds",
  "subtreeAgentId",
  "subtreeAgentIds",
  "subtreeRootAgentId",
  "subtreeRootAgentIds",
] as const;

const CROSS_ISSUE_WRITE_SCOPE_PREFIXES = ["project:", "agent:", "subtree:"] as const;

function isEmptyScopeValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.every(isEmptyScopeValue);
  return false;
}

/** A recognized key or prefix carrying at least one non-empty value. */
export function crossIssueWriteScopeIsConstrained(scope: Record<string, unknown> | null | undefined) {
  if (!scope) return false;
  for (const [key, value] of Object.entries(scope)) {
    const recognized =
      (CROSS_ISSUE_WRITE_SCOPE_KEYS as readonly string[]).includes(key) ||
      CROSS_ISSUE_WRITE_SCOPE_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (recognized && !isEmptyScopeValue(value)) return true;
  }
  return false;
}

/**
 * Returns an operator-facing error message when the grant may not be saved, or
 * null when the scope is acceptable. Only `issues:cross-write` is checked; every
 * other permission key keeps its existing (looser) scope contract.
 */
export function crossIssueWriteGrantScopeError(
  permissionKey: string,
  scope: Record<string, unknown> | null | undefined,
): string | null {
  if (permissionKey !== CROSS_ISSUE_WRITE_PERMISSION_KEY) return null;
  if (crossIssueWriteScopeIsConstrained(scope)) return null;
  return (
    `An \`${CROSS_ISSUE_WRITE_PERMISSION_KEY}\` grant must be scoped to at least one project or ` +
    `assignee. Use one of ${CROSS_ISSUE_WRITE_SCOPE_KEYS.slice(0, 4).join(", ")} (or a ` +
    `\`project:\`/\`agent:\`/\`subtree:\` prefixed key). An empty scope, or a scope made only of ` +
    `keys the authorization evaluator does not recognize, would read as company-wide write access.`
  );
}
