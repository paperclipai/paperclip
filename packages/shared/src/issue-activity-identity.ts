/**
 * Whether a task activity changes which tasks a viewer can list or how they
 * are named: a created, deleted, hidden, unhidden or renamed task.
 *
 * Live events reach authenticated browsers without `details`, so the server
 * computes this closed boolean from the full activity and sends it as
 * `taskIdentityChanged`. It carries no task content. Clients that receive full
 * details (local trusted mode) can compute the same answer themselves.
 */
export const TASK_IDENTITY_CHANGED_FIELD = "taskIdentityChanged" as const;

const TASK_IDENTITY_ACTIONS = new Set(["issue.created", "issue.child_created", "issue.deleted"]);
const TASK_IDENTITY_FIELDS = ["title", "hiddenAt"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function issueActivityChangesTaskIdentity(
  action: unknown,
  details: unknown,
): boolean {
  if (typeof action !== "string") return false;
  if (TASK_IDENTITY_ACTIONS.has(action)) return true;
  if (action !== "issue.updated") return false;
  const record = asRecord(details);
  if (!record) return false;
  const changes = asRecord(record.changes);
  return TASK_IDENTITY_FIELDS.some((field) => field in record || (!!changes && field in changes));
}
