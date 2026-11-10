import type { Issue } from "@paperclipai/shared";

export function filterInboxInReviewIssues(
  issues: Issue[],
  options: { attentionTaskIds: ReadonlySet<string> | null; statuses: readonly string[] },
): Issue[] {
  const { attentionTaskIds, statuses } = options;
  if (!attentionTaskIds || statuses.includes("in_review")) return issues;
  return issues.filter((issue) => issue.status !== "in_review" || attentionTaskIds.has(issue.id));
}
