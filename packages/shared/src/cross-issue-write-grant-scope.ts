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
 * `GRANT_SCOPE_CORPUS` cases in `cross-issue-influence-limit.test.ts`, which
 * run every scope through both this check and the evaluator.
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

export const CROSS_ISSUE_WRITE_SCOPE_PREFIXES = ["project:", "agent:", "subtree:"] as const;

/**
 * The two primitives the authorization evaluator reads a grant scope with.
 * They live here, not next to `scopeAllows`, because the save-time check below
 * has to agree with the evaluator exactly: an earlier revision read prefixed
 * *object keys* at save time while the evaluator read prefixed strings out of
 * `scope.allow`, so `{"project:<id>": true}` stored as "scoped" and conferred
 * nothing, and the evaluator-valid `{"allow": ["project:<id>"]}` was refused at
 * save time (FAI-10134 contract correction).
 */
export function grantScopeValueList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

export function grantScopePrefixedValues(grantScope: Record<string, unknown>, prefix: string): string[] {
  return grantScopeValueList(grantScope.allow)
    .filter((rule) => rule.startsWith(prefix))
    .map((rule) => rule.slice(prefix.length))
    .filter((value) => value.length > 0);
}

/** A recognized key, or an `allow` selector, carrying at least one non-empty value. */
export function crossIssueWriteScopeIsConstrained(scope: Record<string, unknown> | null | undefined) {
  if (!scope) return false;
  for (const key of CROSS_ISSUE_WRITE_SCOPE_KEYS) {
    if (grantScopeValueList(scope[key]).length > 0) return true;
  }
  return CROSS_ISSUE_WRITE_SCOPE_PREFIXES.some((prefix) => grantScopePrefixedValues(scope, prefix).length > 0);
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
    `assignee. Use one of ${CROSS_ISSUE_WRITE_SCOPE_KEYS.slice(0, 4).join(", ")}, or an ` +
    `\`allow\` list of \`project:\`/\`agent:\`/\`subtree:\` selectors (for example ` +
    `{"allow":["project:<id>"]}). An empty scope, or a scope made only of keys the authorization ` +
    `evaluator does not recognize, would read as company-wide write access.`
  );
}
