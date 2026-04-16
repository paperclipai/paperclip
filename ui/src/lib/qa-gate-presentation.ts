import type { IssueStatus } from "@paperclipai/shared";

export function getSmartReviewPresentation(input: {
  issueStatus: IssueStatus;
  lastQaSummaryAt: Date | null;
}) {
  const statusLabel = input.lastQaSummaryAt
    ? `Last summary ${input.lastQaSummaryAt.toISOString()}`
    : input.issueStatus === "in_review"
      ? "No QA summary yet"
      : "Not in QA yet";

  if (input.issueStatus === "in_review") {
    return {
      actionLabel: "QA Ship",
      actionStatus: "done" as const,
      statusLabel,
    };
  }

  if (["backlog", "todo", "in_progress", "blocked"].includes(input.issueStatus)) {
    return {
      actionLabel: "Start QA",
      actionStatus: "in_review" as const,
      statusLabel,
    };
  }

  return {
    actionLabel: "QA Closed",
    actionStatus: null,
    statusLabel,
  };
}
