import type { Issue } from "@paperclipai/shared";

/**
 * In-review work still belongs to its reviewer, so it stays out of the inbox
 * unless it needs the viewer: an open card, a linked approval, or the viewer as
 * reviewer (the attention task index). Filtering to "In review" shows it all.
 * Without the index (loading or failed) nothing is hidden, so no ask is lost.
 */
export function filterInboxInReviewIssues(
  issues: Issue[],
  options: { attentionTaskIds: ReadonlySet<string> | null; statuses: readonly string[] },
): Issue[] {
  const { attentionTaskIds, statuses } = options;
  if (!attentionTaskIds || statuses.includes("in_review")) return issues;
  return issues.filter((issue) => issue.status !== "in_review" || attentionTaskIds.has(issue.id));
}
