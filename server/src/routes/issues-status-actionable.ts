/**
 * Statuses that are considered non-actionable.  When an issue transitions
 * from one of these to `todo`, the assignee agent should be woken up.
 */
const NON_ACTIONABLE = new Set([
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "blocked",
]);

type StatusActionableInput = {
  /** The status value explicitly sent in the request body (undefined when status was not changed). */
  requestStatus: string | undefined;
  /** The status of the issue before this update. */
  previousStatus: string;
  /** The status of the issue after this update. */
  newStatus: string;
};

/**
 * Returns `true` when the status transitioned from a non-actionable state
 * (in_progress, in_review, done, cancelled, blocked) to `todo`.
 *
 * The `backlog → *` case is intentionally excluded here because it is
 * handled separately by the existing `statusChangedFromBacklog` check.
 */
export function statusBecameActionable(input: StatusActionableInput): boolean {
  return (
    input.requestStatus !== undefined &&
    NON_ACTIONABLE.has(input.previousStatus) &&
    input.newStatus === "todo"
  );
}
