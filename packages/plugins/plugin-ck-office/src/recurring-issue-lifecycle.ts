const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export interface RecurringIssueSummary {
  id: string;
  title: string;
  status: string;
}

/**
 * Select stale recurring digest issues that can be completed safely.
 *
 * A prior digest with an unresolved interaction remains actionable even after a
 * newer digest exists, so it must never be superseded automatically.
 */
export function supersededRecurringIssues(
  issues: RecurringIssueSummary[],
  currentTitle: string,
  titlePrefix: string,
  pendingInteractionIssueIds: ReadonlySet<string> = new Set(),
): RecurringIssueSummary[] {
  return issues.filter(
    (issue) =>
      issue.title !== currentTitle &&
      issue.title.startsWith(titlePrefix) &&
      !TERMINAL_ISSUE_STATUSES.has(issue.status) &&
      !pendingInteractionIssueIds.has(issue.id),
  );
}
